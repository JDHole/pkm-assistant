/**
 * config/limits.js — Kagańce agentów (E1.5 / R3, 2026-07-21)
 *
 * JEDNO miejsce na twarde limity pętli narzędziowych agenta głównego i sub-agentów.
 * Wcześniej te stałe były rozsypane po plikach (chat: 10 iteracji, sub-agent: 3/5,
 * timeout delegacji: 60000ms, obcinanie wyniku narzędzia: 15000 znaków) i rozjeżdżały
 * się z dokumentacją. Tutaj są w jednym miejscu, z komentarzem skąd każda wartość.
 *
 * ZERO importów z `obsidian` ani z modułów — czysty config, w pełni testowalny node'em.
 * Importowany BEZPOŚREDNIO (jak `config/default_settings.js`), nie przez barrel modułu.
 *
 * User może nadpisać każdy limit przez `settings.pkmAssistant.limits.<klucz>`. `getLimits()`
 * waliduje override (liczba dodatnia + twardy sufit) i przy śmieciu spada na default.
 */

/**
 * Domyślne wartości limitów. Każda z komentarzem: skąd wartość i po co.
 * Wartości muszą się zgadzać z dokumentacją (`modules/sub-agents/CLAUDE.md`,
 * `modules/chat/CLAUDE.md`) — to JEDEN kanoniczny zestaw.
 */
export const DEFAULT_LIMITS = {
  // Ile rund tool-callingu robi GŁÓWNA pętla czatu (agent) zanim zostanie zmuszony do
  // finalnej odpowiedzi BEZ narzędzi (twardy backstop w chat_streaming.js). Wyrównane
  // z domyślnym budżetem researcher-a (8) — E1.5 P4. Wcześniej 10 (i była to miękka
  // granica, którą model mógł ignorować — E1.5 P2 zamienia ją w twardą).
  chat_max_iterations: 8,

  // Ile rund tool-callingu ma sub-agent (generyczny worker) w runAgentLoop (agent-loop).
  // D18: jeden worker dla wszystkich subów — brak osobnego limitu strategist.
  // F4: 8 → 12. Runda 2 Frontu A (2026-08-17, decyzja Kuby): 12 → 25 — worker na żywym
  // smoke zjadł 12/12 na sensownej robocie i został zmuszony do backstopu w połowie
  // zadania. Limit NIE jest głównym strażnikiem (od tego watchdog ciszy + zegar zadania);
  // pilnuje tylko runaway-pętli palącej tygodniowy limit tokenów.
  subagent_max_iterations_worker: 25,

  // Twardy timeout POJEDYNCZEGO zadania delegowanego do sub-agenta (ms). Używany zarówno
  // jako cap całego zadania (DelegateTool._withTimeout) jak i per-model-call w
  // SubAgentRunner → runAgentLoop. Front A (2026-08-17): 120000 → 480000; runda 2 tego
  // samego dnia: 480000 → 900000 (15 min). Od watchdoga ciszy (`subagent_stall_timeout_ms`)
  // zegar ścienny NIE jest głównym strażnikiem — pilnuje trupów watchdog (cisza streamu),
  // a ten limit to awaryjny sufit na bieg, który ŻYJE, ale mieli bez końca. Kalibracja
  // z żywego smoke'a: worker z 25 iteracjami na wolnym moście (synteza sama trwa ~5 min)
  // potrzebuje kilkunastu minut — 8 min zabiłoby go w połowie roboty, czyli powtórka
  // zbrodni ze śledztwa porannego (3 explorery ubite na finalnej syntezie).
  delegation_timeout_ms: 900000,

  // Front A — WATCHDOG CISZY per wywołanie modelu SUB-AGENTA (ms). Timer przezbrajany
  // KAŻDYM chunkiem streamu (i sygnałem bramki) — strzela dopiero po pełnej ciszy modelu.
  // Odróżnia trupa (zero bajtów — znany tryb awarii lokalnego mostu API) od myśliciela
  // (model reasoning długo mieli, ale streamuje choćby podsumowania rozumowania).
  // 180 s, nie 120 jak watchdog czatu — suby dostają zadania z długą syntezą, a most
  // lokalny bywa skąpy w chunki podczas myślenia. 0 = wyłączony (zostaje sam zegar
  // ścienny delegation_timeout_ms, zachowanie sprzed Frontu A).
  subagent_stall_timeout_ms: 180000,

  // Front A — RATOWANIE DOROBKU (znaki). Gdy finalna synteza suba nie powstała (backstop
  // padł / timeout zadania), pętla i DelegateTool budują z surowych wyników narzędzi
  // skrót o tym sufitcie, zamiast oddawać gołą zaślepkę/błąd. 12k znaków ≈ komplet
  // z 12 iteracji po przycięciu per narzędzie. 0 = wyłączone (stare zachowanie: zaślepka).
  subagent_salvage_max_chars: 12000,

  // Runda 2 Frontu A/B (2026-08-17) — SUFIT WYNIKU SUBA przy doręczeniu do maina (znaki).
  // Wynik suba to DELIVERABLE (deep research po kilku minutach roboty), nie surowy zrzut
  // narzędzia — a dotąd szedł przez wspólny `max_tool_result_length` (15k) i żywy smoke
  // pokazał wynik ucięty w połowie. Dotyczy OBU dróg powrotu: powiadomienia z tła
  // (buildSubTaskNotificationText) i wyniku narzędzia `delegate` w pętli maina
  // (per-tool override w AgentLoop). 0 = bez limitu.
  subagent_result_max_chars: 60000,

  // F5 — GRACE-OKNO na finalne podsumowanie suba (ms). `delegation_timeout_ms` obejmuje CAŁY
  // bieg, więc budzik potrafił strzelić dokładnie wtedy, gdy sub pisał już finalne
  // podsumowanie (backstop) — zadanie zjadało pełny budżet na narzędzia i oddawało zaślepkę
  // zamiast dorobku. Gdy timeout łapie bieg W FINALNEJ ITERACJI, `DelegateTool` nie abortuje
  // od razu: uzbraja JEDNORAZOWY drugi budzik na tyle milisekund. W zwykłej iteracji abort
  // leci natychmiast, jak dotąd. Front A (2026-08-17): 45000 → 120000 — na wolnym moście
  // lokalnym z modelem reasoning na max effort jedna synteza z pełnym kontekstem realnie
  // zajmuje ~2 min (śledztwo 2026-08-17: 45 s to była fikcja, suby ginęły seryjnie).
  subagent_final_grace_ms: 120000,

  // Do ilu znaków obcinamy wynik JEDNEGO narzędzia sub-agenta (oszczędność tokenów).
  // 0 = bez limitu (strategists mają 0 per-rola). Researcher default: 15000. Źródło:
  // SubAgentLoader DEFAULT_RESEARCHER_MAX_TOOL_RESULT_LENGTH === 15000.
  max_tool_result_length: 15000,

  // S33 Z1 — strażnik GŁĘBOKOŚCI delegacji. Ile pięter delegacji wolno zbudować, licząc
  // od agenta głównego. Default 1 = agent może odpalić sub-agenta, a sub-agent NIE deleguje
  // dalej (jego wywołanie `delegate` jest odrzucane). Bez tego kagańca łańcuch sub→sub→sub
  // mnoży się wykładniczo: pali tokeny, gubi tożsamość zlecającego i omija budżet iteracji.
  max_delegation_depth: 1,

  // S33 Z1 — strażnik SZEROKOŚCI delegacji. Ile zadań wolno wsadzić do JEDNEGO wywołania
  // `delegate` w trybie multi-task (`args.tasks[]`, odpalane równolegle przez Promise.all).
  // Powyżej limitu odrzucamy CAŁE wywołanie (nie tniemy po cichu) — model ma podzielić
  // robotę na partie. Chroni przed 50 równoległymi subami zarzynającymi API i UI.
  max_parallel_delegations: 5,

  // S33 Z2: max wysyłek per para nadawca→adresat w oknie 10 min. Strażnik siedzi w narzędziu
  // `kom_send` (warstwa agenta) — user piszący z panelu komunikatora nie podlega limitowi.
  // Chroni przed pętlą „agent odpisuje agentowi" zalewającą skrzynkę i palącą tokeny.
  kom_send_rate_max: 20,

  // Werdykt Kuby 16.08 (2026-08-27): sufit ŁAŃCUCHA auto-tur po subach z rzędu. Wynik suba
  // odpalonego w tle wraca do czatu jako AUTO-TURA (`_deliverSubTaskResult` → `send_message`,
  // modules/chat/chat/chat_streaming.ts) BEZ udziału człowieka. Agent w tej turze może zlecić
  // KOLEJNEGO suba w tle, jego wynik znów odpala auto-turę — bez sufitu rozmowa jedzie sama
  // w nieskończoność. `max_delegation_depth` NIE chroni: auto-tura to nowa tura agenta
  // GŁÓWNEGO, więc głębokość delegacji liczy się od zera przy każdym ogniwie łańcucha.
  // Licznik zeruje PRAWDZIWA wiadomość człowieka (`resolveMessageOrigin(meta) === 'human'`);
  // rośnie WYŁĄCZNIE auto-tura ze znacznikiem `_subTaskNotification` — inne wysyłki maszynowe
  // (guzik artefaktu, propozycja delegacji) nie są tym łańcuchem. Po przekroczeniu wynik NIE
  // ginie: zostaje w kolejce `SubTaskNotifier` (ten sam fallback co nieaktywna zakładka) i
  // wraca w najbliższej turze, którą zacznie człowiek.
  // Default 10, nie 5 (decyzja Kuby 2026-08-27): licznik liczy DORĘCZENIA, nie rekurencję,
  // więc legalny fan-out `max_parallel_delegations` (5) zjadałby cały budżet łańcucha jednym
  // zleceniem — 10 daje dwa pełne fan-outy oddechu, a pętlę bez człowieka dławi tak samo.
  max_consecutive_auto_turns: 10,

  // K12 (2026-08-23, ogon K6): DRUGI sufit — max wysyłek jednego NADAWCY w tym samym oknie
  // 10 min, niezależnie od adresata. Sam limit per para nie domykał sprawy: zepsuty agent
  // rozsyłał `kom_send_rate_max` × liczba adresatów, mieszcząc się w każdej parze z osobna.
  // Oba sufity działają koniunkcyjnie; user piszący z panelu nadal poza limitem (jego droga
  // w ogóle nie przechodzi przez `reserveSend`).
  kom_send_rate_max_sender: 40,

  // Bramka równoległości requestów do platform LOKALNYCH (lm_studio, ollama) — ile
  // requestów do modelu może lecieć naraz. Lokalny most (proxy zgodne z LM Studio) przy kilku
  // połączeniach otwartych w tej samej chwili potrafi cicho zwisnąć (zero bajtów, bez
  // błędu — incydent 2026-08-11), a i tak przerabia requesty po kolei, więc default 1
  // nic nie kosztuje. Chmura bramki NIE dostaje (patrz modelResolver.isLocalPlatform +
  // ChatModel._streamGateLimit) — tam równoległość jest normalna, przeciążenie
  // kończy się głośnym 429.
  local_platform_max_concurrent: 1,

  // F4 (capy → budżety): ile znaków INSTRUKCJI custom suba (`config.prompt`, czyli KNOWLEDGE.md)
  // wchodzi do jego promptu systemowego. Wcześniej hardcode 6000 w `SubAgentRunner._buildTaskPrompt`
  // — cap jakościowy wpisany na sztywno „przeciw encyklopediom". Instrukcja jest karmą dla modelu,
  // a nie wynikiem narzędzia: user, który świadomie napisał dłuższą metodę, ma prawo ją wysłać.
  // Cap ZOSTAJE (obcięcie z widoczną notą), tylko przestaje być tajemnicą kodu.
  subagent_prompt_max_chars: 24000,

  // F4 (capy → budżety): ile znaków `context` przekazanego przez rodzica w `delegate` dociera
  // do suba. Wcześniej hardcode 16000 w `DelegateTool._executeSubAgent`. To najważniejszy kanał
  // „rodzic wie coś, czego sub nie wyszuka" — 16k było ciasne dla okien 128k+.
  delegation_context_max_chars: 48000,

  // Watchdog martwego streamu czatu (ms): ile ciszy modelu (zero chunków) tolerujemy,
  // zanim tura zostanie przerwana tą samą ścieżką co ręczny Stop (chat_streaming
  // `_onStreamStall`). Licznik startuje z wywołaniem modelu, resetuje go każdy chunk
  // i NIE biegnie podczas wykonywania narzędzi (osobna warstwa: modules/tools/
  // server_timeout.js 60/180 s). 0 = wyłączony. Default 120 s — modele reasoning
  // potrafią długo myśleć zanim oddadzą pierwszy token (spójne z delegation_timeout_ms);
  // twardy sufit XHR w adapterze to 600 s, watchdog ma strzelać wyraźnie wcześniej.
  // Runda 2 (2026-08-17): watchdog czatu zbroi się od WEJŚCIA NA SLOT bramki
  // (gate_admitted), nie od zlecenia — czekanie w kolejce mostu za długą syntezą suba
  // nie jest ciszą modelu (incydent 09:15Z: tura Kuby ubita po 120 s stania w kolejce).
  chat_stream_stall_timeout_ms: 120000,

  // Friendly fire 2026-08-15: budzik per-WYWOŁANIE modelu w CZACIE (pas ostateczny pętli;
  // suby mają swój od dawna — delegation_timeout_ms). Watchdog ciszy wyżej łapie brak
  // chunków, ale NIE łapie promisy, która nigdy się nie rozstrzygnie (XHR ubity z zewnątrz —
  // transport strumienia nie emituje zdarzenia na abort, więc pętla wisiałaby wiecznie). Kolejka
  // bramki lokalnej się NIE liczy (gate_admitted przezbraja budzik) — ale przezbrojenie
  // jest JEDNO, więc faza kolejki też musi się zmieścić w budżecie. Runda 2 (2026-08-17):
  // 300000 → 600000 — kolejka za syntezą suba na jednopasmowym moście trwa realnie
  // do kilku minut (smoke: 5:39) i pas ostateczny nie ma prawa jej ubić.
  chat_model_call_timeout_ms: 600000,
};

/** Klucz limitu — wprost z kształtu `DEFAULT_LIMITS` (jedno źródło prawdy, zero duplikacji). */
export type LimitKey = keyof typeof DEFAULT_LIMITS;

/** Reguła walidacji pojedynczego limitu (patrz `LIMIT_SPECS`). */
export type LimitSpec = { min: number; ceiling: number; integer: boolean };

/**
 * Reguły walidacji per limit.
 * - `min`      — podłoga; override poniżej → spada na default (nie da się wyłączyć pętli
 *                ustawiając 0 iteracji).
 * - `ceiling`  — TWARDY sufit; override powyżej jest przycinany do sufitu (chroni przed
 *                runaway pętlą palącą tokeny / zawieszonym UI). Nie da się przekroczyć.
 * - `integer`  — override zaokrąglany w dół do liczby całkowitej.
 *
 * Eksportowane, żeby Settings UI mogło pokazać podpowiedzi (min/max) bez duplikacji.
 */
export const LIMIT_SPECS: Record<LimitKey, LimitSpec> = {
  chat_max_iterations:                { min: 1,    ceiling: 50,     integer: true },
  // Runda 2: sufit 50 → 100 (decyzja Kuby: sub ma pracować aż skończy; strażnikami są
  // watchdog ciszy i zegar zadania, iteracje to tylko kaganiec na runaway-pętlę).
  subagent_max_iterations_worker:     { min: 1,    ceiling: 100,    integer: true },
  // Runda 2: sufit 600000 → 1800000 (30 min) — worker z podniesionym budżetem iteracji
  // na wolnym moście potrzebuje kilkunastu minut; 10 min sufitu wiązało ręce userowi.
  delegation_timeout_ms:              { min: 1000, ceiling: 1800000, integer: true },
  // F5: min 5000 — poniżej pięciu sekund grace-okno jest fikcją (jedno wywołanie modelu
  // z pełnym kontekstem tyle nie zdąży). Sufit 240000 (Front A; było 120000 = ówczesny
  // budżet całego zadania) — więcej niż 4 min na JEDNĄ syntezę to już nie grace, tylko
  // drugie życie. Nie ma tu 0 „wyłącz" — od tego jest krótki `delegation_timeout_ms`.
  subagent_final_grace_ms:            { min: 5000, ceiling: 240000, integer: true },
  // Front A: 0 legalny (= watchdog ciszy wyłączony, zostaje zegar ścienny). Sufit = twardy
  // timeout XHR adaptera (600 s) — dłuższa cisza to już na pewno trup, nie myśliciel.
  subagent_stall_timeout_ms:          { min: 0,    ceiling: 600000, integer: true },
  // Front A: 0 legalny (= ratowanie dorobku wyłączone, stara zaślepka). Sufit jak
  // max_tool_result_length — skrót dorobku karmi to samo okno kontekstu agenta głównego.
  subagent_salvage_max_chars:         { min: 0,    ceiling: 200000, integer: true },
  // Runda 2: 0 legalny (= wynik suba bez limitu). Sufit jak wyżej — deliverable też
  // karmi okno kontekstu maina, tylko domyślna porcja jest 4× większa niż zrzut narzędzia.
  subagent_result_max_chars:          { min: 0,    ceiling: 200000, integer: true },
  // 0 jest legalny (= bez limitu). Sufit chroni przed absurdalnie dużym oknem kontekstu.
  max_tool_result_length:             { min: 0,    ceiling: 200000, integer: true },
  // F4: min 1000 = instrukcji suba nie da się ściąć do zera (sub bez metody to nie sub).
  // Sufit 100k — powyżej sama rama zjada okno modelu, zanim padnie pierwsze pytanie.
  subagent_prompt_max_chars:          { min: 1000, ceiling: 100000, integer: true },
  // F4: min 1000 (kontekst od rodzica ma sens dopiero od akapitu w górę), sufit 200000 —
  // tyle, co sufit wyniku narzędzia; oba karmią to samo okno kontekstu suba.
  delegation_context_max_chars:       { min: 1000, ceiling: 200000, integer: true },
  // 0 jest legalny (= watchdog wyłączony). Sufit = twardy timeout XHR adaptera (600 s).
  chat_stream_stall_timeout_ms:       { min: 0,    ceiling: 600000, integer: true },
  // 0 legalny (= budzik wyłączony). Sufit 900 s — powyżej tego to już nie jest „wolny
  // model", tylko martwy request; watchdog ciszy i tak strzela wcześniej przy braku chunków.
  chat_model_call_timeout_ms:         { min: 0,    ceiling: 900000, integer: true },
  // S33 Z1: min 1 = delegacja zawsze musi być możliwa z poziomu agenta (0 wyłączyłoby
  // narzędzie tylnymi drzwiami). Sufit 3 — trzy piętra to już bardzo dużo, dalej to
  // rekurencja paląca tokeny w tle.
  max_delegation_depth:               { min: 1,    ceiling: 3,      integer: true },
  // S33 Z1: min 1 (zawsze wolno jedno zadanie), sufit 20 — powyżej to atak na własne API.
  max_parallel_delegations:           { min: 1,    ceiling: 20,     integer: true },
  // S33 Z2: min 1 (poczta agentów nigdy nie jest wyłączana limitem — od tego jest
  // kill-switch komunikatora), sufit 500 = „praktycznie bez limitu" dla świadomego usera.
  kom_send_rate_max:                  { min: 1,    ceiling: 500,    integer: true },
  // Werdykt Kuby 16.08: min 1 (auto-tura po SUBIE zawsze może wystartować przynajmniej raz —
  // to nie jest wyłącznik funkcji, tylko kaganiec na ŁAŃCUCH, jak max_delegation_depth wyżej).
  // Sufit 20 — rozmowa jadąca sama bez człowieka dłużej niż to jest już z definicji awarią,
  // nie robotą w tle.
  max_consecutive_auto_turns:         { min: 1,    ceiling: 20,     integer: true },
  // K12: sufit nadawcy stoi PONAD limitem pary, więc i jego widełki są szersze — min 1
  // (ta sama zasada: poczty nie wyłącza się limitem), sufit 2000 = „praktycznie bez limitu".
  kom_send_rate_max_sender:           { min: 1,    ceiling: 2000,   integer: true },
  // Min 1 = bramki lokalnej nie da się wyłączyć na zero (to by zablokowało wszystkie
  // requesty). Sufit 10 — lokalny most i tak nie przerobi więcej naraz.
  local_platform_max_concurrent:      { min: 1,    ceiling: 10,     integer: true },
};

/**
 * Sanityzuje pojedynczy override wg LIMIT_SPECS.
 * @param key - klucz limitu (dowolny string — nieznany klucz spada na fallback)
 * @param rawValue - surowa wartość z settings (dowolny typ)
 * @param fallback - default do którego spadamy przy śmieciu
 */
function sanitizeLimit(key: string, rawValue: unknown, fallback: number): number {
  const spec = LIMIT_SPECS[key as LimitKey];
  if (!spec) return fallback;
  // Only real numbers or numeric strings ("9" from a text input) are acceptable.
  // Booleans/objects/arrays/null coerce to surprising numbers — reject them outright.
  if (typeof rawValue !== 'number' && typeof rawValue !== 'string') return fallback;
  let n: number = Number(rawValue);
  if (!Number.isFinite(n)) return fallback;      // NaN, Infinity, "abc" → default
  if (spec.integer) n = Math.floor(n);
  if (n < spec.min) return fallback;             // ujemne / za małe → default
  if (n > spec.ceiling) return spec.ceiling;     // twardy sufit
  return n;
}

/**
 * Zwraca efektywne limity: defaulty zmergowane z user override (settings.pkmAssistant.limits.*).
 * Każdy override jest walidowany (liczba dodatnia + twardy sufit); śmieć → default.
 * Bezpieczne dla `undefined`/niepełnych settings — zawsze zwraca komplet kluczy.
 *
 * @param settings - obiekt settings (np. plugin.env.settings). Może być undefined.
 */
export function getLimits(
  settings?: { pkmAssistant?: { limits?: Record<string, unknown> } } | null,
): Record<LimitKey, number> {
  const overrides = (settings && settings.pkmAssistant && settings.pkmAssistant.limits) || {};
  const out = {} as Record<LimitKey, number>;
  for (const key of Object.keys(DEFAULT_LIMITS) as LimitKey[]) {
    const def = DEFAULT_LIMITS[key];
    out[key] = Object.prototype.hasOwnProperty.call(overrides, key)
      ? sanitizeLimit(key, overrides[key], def)
      : def;
  }
  return out;
}
