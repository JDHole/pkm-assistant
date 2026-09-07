/**
 * Stabilny hash tekstu — ziarno dla deterministycznych generatorów UI
 * (kolory agentów, kształty kryształów, ikony).
 *
 * Kontrakt: ta sama wartość wejściowa daje ten sam wynik w każdej sesji i na każdej
 * platformie; wynik jest nieujemną liczbą całkowitą. Nie jest to hash kryptograficzny.
 */

/**
 * Ziarno spoza kontraktu sprowadzone do tekstu.
 *
 * `null`/`undefined` (nazwa agenta, gdy profil jeszcze się ładuje) i wszystko, co nie jest
 * prostą wartością, dostają pusty napis — dla obiektu `String()` i tak oddałoby jeden
 * i ten sam `[object Object]`, więc nie udajemy, że je rozróżniamy.
 */
function asText(input: unknown): string {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
        return String(input);
    }
    return '';
}

/**
 * Miesza akumulator przesunięciami bitowymi — jeden krok „dodaj i rozsyp".
 *
 * Całe mieszanie stoi na przesunięciach i XOR-ze, bez mnożenia: `<<` i `>>>` w JS liczą
 * na 32 bitach z definicji, więc wynik nie ma jak uciec w mantysę `double` i jest
 * identyczny na każdej maszynie. `| 0` po dodaniu przycina przeniesienie z powrotem
 * do 32 bitów ze znakiem (znak zdejmuje dopiero `>>> 0` na końcu).
 */
function scatter(acc: number, shiftUp: number, shiftDown: number): number {
    const spread = (acc + (acc << shiftUp)) | 0;
    return spread ^ (spread >>> shiftDown);
}

/**
 * Zwija tekst do 32-bitowej, nieujemnej liczby.
 *
 * Wybór algorytmu: liczy się WYŁĄCZNIE determinizm i tanie, równomierne rozrzucenie
 * sąsiednich napisów („Klara" i „Klara2" mają dać różne kolory). Znak po znaku dokładamy
 * kod do akumulatora i rozsypujemy go {@link scatter}; na końcu idzie jeszcze jedna
 * runda rozsypki (lawina), żeby ostatni dołożony znak zdążył wpłynąć na wszystkie bity —
 * bez niej napisy różniące się tylko końcówką lądowałyby w sąsiednich kubełkach.
 *
 * Wejście spoza `string` (nazwa agenta bywa `undefined`, gdy profil jeszcze się ładuje)
 * jest sprowadzane do tekstu — generator ma dostać ziarno zamiast wyjątku w środku
 * rysowania ikony.
 */
export function seededStringHash(input: unknown): number {
    const text = asText(input);
    let acc = 0;
    for (let i = 0; i < text.length; i++) {
        acc = scatter((acc + text.charCodeAt(i)) | 0, 10, 6);
    }
    acc = scatter(acc, 3, 11);
    // `>>> 0` zdejmuje znak — kontrakt mówi „nieujemna liczba całkowita", a konsumenci
    // robią na wyniku `% długość_tablicy`, które przy ujemnym ziarnie dałoby indeks -1.
    return ((acc + (acc << 15)) | 0) >>> 0;
}
