/**
 * `waitForLoaded` — czekanie na `state === 'loaded'`, wyłuskane z `PluginRuntime.whenLoaded()`.
 *
 * DLACZEGO OSOBNY PLIK: `PluginRuntime.ts` importuje `obsidian`, więc nie wstaje w AVA (testy
 * nie mają mocka `obsidian`). Ten plik nie importuje NICZEGO — dzięki temu jedyny
 * kawałek logiki `whenLoaded`, który da się sprawdzić naprawdę (a nie regexem po źródle),
 * jest sprawdzany naprawdę. `PluginRuntime.whenLoaded()` jest cienką otoczką na tę funkcję,
 * dokładnie jak `whenLoaded_layout_ready()` jest otoczką na `waitForLayoutReady`
 * z `core/layoutReady.ts` (ten sam wzór, ta sama przyczyna).
 *
 * DLACZEGO W OGÓLE: `whenLoaded` czekał WYŁĄCZNIE siatką `setInterval` 100 ms, bez
 * sprawdzenia warunku na wejściu — `setInterval` z definicji nie odpala się przed
 * pierwszym tickiem, więc nawet gotowy env czekał do pełnych 100 ms, PEŁNE 100 ms przy
 * KAŻDYM otwarciu zakładki Ustawień (`modules/shell/pkm_settings_tab.ts`), gdzie env
 * prawie zawsze jest już gotowy. Naprawa idzie za zasadą „zegar → zdarzenie"
 * (core/CLAUDE.md, gotcha 6c): sprawdzenie na wejściu + rozwiązanie na zdarzenie
 * `'loaded'` + siatka odpytywania WYŁĄCZNIE jako asekuracja (rzadsza, kasowana po
 * rozwiązaniu, nie przeżywa `'unloading'`).
 *
 * `check()` (tick siatki) sam wykrywa pojawienie się / zmianę instancji i dopina
 * subskrypcję do AKTUALNEJ — bo `getEnv()` w chwili wywołania może jeszcze nie zwracać
 * env (jeszcze nie istnieje), albo `create()` może PODMIENIĆ instancję pod nami
 * (`reload`, `core/PluginRuntime.ts:541-551` — nowy obiekt, nowa szyna zdarzeń);
 * subskrypcja tylko przy starcie złapałaby oba przypadki dopiero na najbliższym ticku
 * siatki, nie na zdarzeniu — siatka wraca do roli czystej asekuracji również na tej
 * ścieżce, nie tylko przy starcie.
 *
 * NIE eksportowane przez `core/index.ts` — konsument jest jeden i siedzi wewnątrz
 * `core/`, więc importuje wprost (złota zasada dotyczy wejścia Z ZEWNĄTRZ modułu).
 */

/** Minimalny kształt szyny zdarzeń, którego tu potrzebujemy — `EventBus` go spełnia. */
import { hostWindow, type HostTimer } from './utils/hostWindow.js';

export interface RuntimeLoadedEvents {
  on(event_key: string, callback: () => void): () => void;
}

/** Minimalny kształt środowiska, którego tu potrzebujemy — `PluginRuntime` go spełnia. */
export interface RuntimeLoadedSource {
  state: string;
  events?: RuntimeLoadedEvents;
}

/**
 * Rozwiązuje się, gdy `getEnv().state === 'loaded'`.
 *
 * `getEnv` jest funkcją, nie wartością, bo w prawdziwym `PluginRuntime.whenLoaded()` (statyczny)
 * środowisko może jeszcze nie istnieć w chwili wywołania ALBO zostać podmienione na inną
 * instancję w trakcie oczekiwania (`create()` przy `reload`) — siatka bezpieczeństwa
 * re-sprawdza `getEnv()` na każdym ticku, więc łapie oba przypadki, nie tylko spóźnione
 * powstanie pierwszej instancji.
 *
 * Trzy drogi rozwiązania, w kolejności pierwszeństwa:
 *   1. natychmiast, jeśli środowisko jest już 'loaded' w chwili wywołania — zero timera;
 *   2. na zdarzenie `'loaded'` z `events` AKTUALNEJ instancji zwróconej przez `getEnv()` —
 *      subskrypcja jest ponownie oceniana na KAŻDYM ticku siatki (nie tylko przy starcie),
 *      więc instancja, która pojawiła się później albo zastąpiła poprzednią, też dostaje
 *      swojego słuchacza zamiast zostać złapaną wyłącznie tickiem;
 *   3. siatką bezpieczeństwa o okresie `pollMs` — jedyna droga, gdy `getEnv()` w danej
 *      chwili zwraca `undefined` (jeszcze nie ma do czego się podpiąć), albo gdyby
 *      zdarzenie z jakiegoś powodu nie doleciało.
 *
 * Zdarzenie `'unloading'` z bieżąco podpiętej szyny **PORZUCA** oczekiwanie na zawsze —
 * timer i wszystkie subskrypcje są kasowane, a zwrócona promise NIGDY się nie rozwiąże.
 * To celowe, nie tylko sprzątanie: po `'unloading'` (demontaż pluginu)
 * nie ma już czekać na CO — kontynuowanie oczekiwania na kolejną, późniejszą instancję
 * env byłoby zombie-`initialize()` działającym na cudzym (kolejnym) środowisku. Wołacz,
 * który naprawdę potrzebuje gotowego env po restarcie, ma wywołać `whenLoaded()` PONOWNIE,
 * nie polegać na tym, że stara obietnica się doczeka. (Dzięki temu siatka nie mieli bez
 * końca po nieudanym `load()` — `state` nie zna dziś wartości `'error'`, więc nie trzeba
 * osobnego stanu błędu, żeby to domknąć.)
 */
/** Domyślne ziarno siatki bezpieczeństwa. */
export const WAIT_FOR_LOADED_POLL_MS = 250;

export function waitForLoaded<T extends RuntimeLoadedSource>(
  getEnv: () => T | undefined,
  pollMs = WAIT_FOR_LOADED_POLL_MS,
): Promise<T> {
  return new Promise((resolve) => {
    let interval: HostTimer | null = null;
    let unsub_loaded: (() => void) | null = null;
    let unsub_unloading: (() => void) | null = null;
    let subscribed_env: T | undefined;
    let settled = false;
    let abandoned = false;

    const unsubscribe_current = () => {
      if (unsub_loaded) { unsub_loaded(); unsub_loaded = null; }
      if (unsub_unloading) { unsub_unloading(); unsub_unloading = null; }
      subscribed_env = undefined;
    };

    const stop = () => {
      // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy
      // AVA / harness, zero `window`).
      if (interval) { hostWindow.clearInterval(interval); interval = null; }
      unsubscribe_current();
    };

    const settle = (env: T) => {
      if (settled || abandoned) return;
      settled = true;
      stop();
      resolve(env);
    };

    /** Zdarzenie `'unloading'` — porzucenie NA ZAWSZE, patrz komentarz funkcji wyżej. */
    const abandon = () => {
      if (settled || abandoned) return;
      abandoned = true;
      stop();
    };

    const check = () => {
      if (settled || abandoned) return;
      const env = getEnv();
      if (env && env.state === 'loaded') {
        settle(env);
        return;
      }
      // Instancja pojawiła się dopiero teraz, albo `create()` podmienił ją pod nami
      // (`reload`, `core/PluginRuntime.ts`) — dopnij subskrypcję do AKTUALNEJ instancji,
      // żeby siatka wróciła do roli asekuracji zamiast zostać jedyną drogą aż do resolve.
      if (env && env !== subscribed_env && env.events) {
        unsubscribe_current();
        subscribed_env = env;
        unsub_loaded = env.events.on('loaded', check);
        unsub_unloading = env.events.on('unloading', abandon);
      }
    };

    // (1)+(2) Sprawdzenie NATYCHMIAST, zanim powstanie jakikolwiek timer — główna droga
    // (Ustawienia, gdzie env prawie zawsze już 'loaded') kończy się tu, zero czekania.
    // Przy okazji dopina subskrypcję, jeśli env już istnieje, ale jeszcze nie jest gotowy.
    check();
    if (settled || abandoned) return;

    // (3) Siatka bezpieczeństwa — jedyna droga, dopóki `getEnv()` zwraca `undefined`, a poza
    // tym re-ocenia na każdym ticku, czy instancja się pojawiła / zmieniła (patrz `check()`).
    // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
    // zero `window`).
    interval = hostWindow.setInterval(check, pollMs);
  });
}
