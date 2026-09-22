/**
 * SessionWriteConsent
 *
 * Zgoda „Nie pytaj więcej w tej sesji o zapisy do tego pliku" — wariant NAJBEZPIECZNIEJSZY:
 * PER PLIK i PER SESJA CZATU, wyłącznie w RAM. Gaśnie z końcem sesji (nowy klucz sesji, np. po
 * `handleNewSession` w czacie) i z przeładowaniem pluginu (nowa instancja `MCPClient`, patrz
 * `modules/tools/CLAUDE.md`). Nic nie trafia na dysk — to odróżnia ją od
 * `ApprovalManager.alwaysApproved` (trwała reguła „Zawsze zezwalaj", zapisywana w ustawieniach).
 *
 * Klucz sesji ma być `origin.sessionPath` z wywołania narzędzia (`MCPClient.executeToolCall`) —
 * NIGDY `agentName` ani `tabKey` (oba nie identyfikują jednoznacznie rozmowy, patrz gotcha
 * w `modules/tools/CLAUDE.md`). Ścieżki porównywane są DOSŁOWNIE — wołacz ma podać formę
 * kanoniczną, tę samą, którą oceniła bramka uprawnień.
 *
 * Czysta logika, zero importu `obsidian` — testowalna w AVA bez atrapy.
 */
export class SessionWriteConsent {
    /** sessionKey → zbiór ścieżek, na które user powiedział „nie pytaj więcej w tej sesji". */
    private readonly grants = new Map<string, Set<string>>();

    /**
     * Zapamiętaj zgodę na zapis do `path` w sesji `sessionKey`.
     *
     * Pusty klucz sesji albo pusta ścieżka to no-op — nie ma czego zapamiętać bez adresu —
     * i metoda mówi to wprost zwracając `false`, zamiast cicho nic nie robić.
     *
     * @returns `true` jeśli zgoda została zapamiętana, `false` przy pustym kluczu/ścieżce.
     */
    grant(sessionKey: string | null | undefined, path: string | null | undefined): boolean {
        if (!sessionKey || !path) return false;
        let paths = this.grants.get(sessionKey);
        if (!paths) {
            paths = new Set();
            this.grants.set(sessionKey, paths);
        }
        paths.add(path);
        return true;
    }

    /** Czy sesja `sessionKey` ma już zgodę na zapis do `path`. Pusty klucz/ścieżka = zawsze `false`. */
    has(sessionKey: string | null | undefined, path: string | null | undefined): boolean {
        if (!sessionKey || !path) return false;
        return this.grants.get(sessionKey)?.has(path) ?? false;
    }

    /** Kasuje wszystkie zgody JEDNEJ sesji (np. gdy wołacz chce jawnie zakończyć sesję). */
    clearSession(sessionKey: string | null | undefined): void {
        if (!sessionKey) return;
        this.grants.delete(sessionKey);
    }

    /** Kasuje WSZYSTKIE zgody wszystkich sesji. */
    clear(): void {
        this.grants.clear();
    }
}
