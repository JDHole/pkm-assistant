# Third-Party Licenses

`dist/main.js` w tym repo (bundel produkowany przez `esbuild.js`) zawiera zminifikowany
kod kilku bibliotek open-source obok kodu własnego pluginu. Ten plik zbiera noty
copyrightowe i teksty licencji tych bibliotek — spełnienie warunku "dołącz notę
licencyjną" przy redystrybucji w formie zbundlowanej (MIT/ISC/BSD wymagają zachowania
noty copyright + tekstu licencji; Apache-2.0 dodatkowo wymaga dołączenia kopii licencji).

**Metoda:** lista niżej pochodzi z realnej zawartości bundla (`esbuild` z `metafile: true`,
policzone `bytesInOutput > 0` per plik wejściowy po tree-shakingu), nie z samego
`package.json` → `dependencies`. To ważne rozróżnienie: `@modelcontextprotocol/sdk` ma we
własnym `package.json` dużo więcej zależności (np. `express`, `hono`, `cors`, `jose`) niż
faktycznie trafia do tego bundla — części server-transportowej SDK ten plugin (klient MCP)
nie importuje, więc tree-shaking ją usuwa. Zweryfikowano 2026-08-27 przy AUD-deps-009.

## Biblioteki w bundlu

| Pakiet | Licencja | Skąd |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | MIT | bezpośrednia zależność (`package.json`) |
| [`@orama/orama`](https://www.npmjs.com/package/@orama/orama) | Apache-2.0 | bezpośrednia zależność (`package.json`) |
| [`ajv`](https://www.npmjs.com/package/ajv) | MIT | tranzytywna, przez SDK |
| [`ajv-formats`](https://www.npmjs.com/package/ajv-formats) | MIT | tranzytywna, przez SDK |
| [`cross-spawn`](https://www.npmjs.com/package/cross-spawn) | MIT | tranzytywna, przez SDK (klient stdio) |
| [`eventsource-parser`](https://www.npmjs.com/package/eventsource-parser) | MIT | tranzytywna, przez SDK (klient HTTP/SSE) |
| [`fast-deep-equal`](https://www.npmjs.com/package/fast-deep-equal) | MIT | tranzytywna, przez `ajv` |
| [`fast-uri`](https://www.npmjs.com/package/fast-uri) | BSD-3-Clause | tranzytywna, przez `ajv` |
| [`isexe`](https://www.npmjs.com/package/isexe) | ISC | tranzytywna, przez `which` |
| [`json-schema-traverse`](https://www.npmjs.com/package/json-schema-traverse) | MIT | tranzytywna, przez `ajv` |
| [`path-key`](https://www.npmjs.com/package/path-key) | MIT | tranzytywna, przez `cross-spawn` |
| [`pkce-challenge`](https://www.npmjs.com/package/pkce-challenge) | MIT | tranzytywna, przez SDK (OAuth PKCE) |
| [`shebang-command`](https://www.npmjs.com/package/shebang-command) | MIT | tranzytywna, przez `cross-spawn` |
| [`shebang-regex`](https://www.npmjs.com/package/shebang-regex) | MIT | tranzytywna, przez `shebang-command` |
| [`which`](https://www.npmjs.com/package/which) | ISC | tranzytywna, przez `cross-spawn` |
| [`zod`](https://www.npmjs.com/package/zod) | MIT | tranzytywna, przez SDK (schematy narzędzi) |
| [`zod-to-json-schema`](https://www.npmjs.com/package/zod-to-json-schema) | ISC | tranzytywna, przez SDK |

---

## Licencja MIT

Dotyczy: `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `cross-spawn`,
`eventsource-parser`, `fast-deep-equal`, `json-schema-traverse`, `path-key`,
`pkce-challenge`, `shebang-command`, `shebang-regex`, `zod`.

Tekst licencji MIT jest identyczny dla wszystkich pakietów — jedyną zmienną częścią jest
nota copyrightowa, więc jest wypisana raz per pakiet, a tekst licencji raz na końcu.

### Noty copyrightowe

- **@modelcontextprotocol/sdk** — Copyright (c) 2024 Anthropic, PBC
- **ajv** — Copyright (c) 2015-2017 Evgeny Poberezkin
- **ajv-formats** — Copyright (c) 2020 Evgeny Poberezkin
- **cross-spawn** — Copyright (c) 2018 Made With MOXY Lda \<hello@moxy.studio\>
- **eventsource-parser** — Copyright (c) 2026 Espen Hovlandsdal \<espen@hovlandsdal.com\>
- **fast-deep-equal** — Copyright (c) 2017 Evgeny Poberezkin
- **json-schema-traverse** — Copyright (c) 2017 Evgeny Poberezkin
- **path-key** — Copyright (c) Sindre Sorhus \<sindresorhus@gmail.com\> (sindresorhus.com)
- **pkce-challenge** — Copyright (c) 2019
- **shebang-command** — Copyright (c) Kevin Mårtensson \<kevinmartensson@gmail.com\> (github.com/kevva)
- **shebang-regex** — Copyright (c) Sindre Sorhus \<sindresorhus@gmail.com\> (sindresorhus.com)
- **zod** — Copyright (c) 2025 Colin McDonnell

### Tekst licencji

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Licencja ISC

Dotyczy: `isexe`, `which`, `zod-to-json-schema`.

### Noty copyrightowe

- **isexe** — Copyright (c) Isaac Z. Schlueter and Contributors
- **which** — Copyright (c) Isaac Z. Schlueter and Contributors
- **zod-to-json-schema** — Copyright (c) 2020, Stefan Terdell

### Tekst licencji

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## Licencja BSD 3-Clause

Dotyczy: `fast-uri`.

### Nota copyrightowa

```
Copyright (c) 2011-2021, Gary Court until
https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.
```

### Tekst licencji

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## Apache License, Version 2.0

Dotyczy: `@orama/orama`.

### Nota copyrightowa

```
Copyright 2023 OramaSearch Inc
```

### Tekst licencji

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

---

## Uwagi

- Ta lista opisuje kod **zbundlowany do `dist/main.js`**, nie pełne drzewo `node_modules`
  (deweloperskie narzędzia jak `esbuild`, `typescript`, `eslint`, `ava` nie trafiają do
  bundla i nie są tu wymienione — ich licencje dotyczą procesu budowania, nie
  dystrybuowanego pluginu).
- `dist/main.js` niesie też kod własny (`core/`, `modules/`, `src/`) na licencji GPL-3.0
  tego repo (patrz `LICENSE` w root) oraz dane i18n. To NIE jest third-party i nie jest
  tu wymienione.
- Release'owy banner w `dist/main.js` (`utils/banner.ts`) wskazuje na ten plik jedną
  linią — pełne noty świadomie mieszkają tutaj, nie w samym bannerze, żeby nie rozdymać
  bundla o kilkanaście kilobajtów tekstu prawnego przy każdym buildzie.
- Lista została ustalona ręcznie 2026-08-27 (AUD-deps-009) na podstawie realnego builda.
  Jeśli w przyszłości dojdzie/zmieni się zależność w `dependencies` w `package.json` albo
  zmieni się to, co SDK importuje pod spodem, ten plik może się zdezaktualizować — nie ma
  dziś automatycznej bramki, która by to wykrywała (rozważyć `license-checker` albo
  podobne narzędzie SCA, jeśli temat wróci).
- **2026-09-07 (TS-4):** `js-yaml` usunięty z listy — wyleciał z `package.json` w całości
  (katalog Obsidiana go wytykał, module-replacements). `core/utils/yamlParser.ts` używa dziś
  wbudowanego `parseYaml`/`stringifyYaml` Obsidiana (silnik wstrzykiwany, `setYamlEngine()`).
  Zamiennik `yaml` (eemeli/yaml) jest wyłącznie **devDependency** dla testów AVA i harnessu —
  produkcyjny `src/main.ts` importuje `parseYaml`/`stringifyYaml` z `'obsidian'` (już na liście
  `external` esbuilda), więc do `dist/main.js` nie trafia ani `js-yaml`, ani `yaml`. Ręczna
  weryfikacja: `grep -c "js-yaml" dist/main.js` = 0.
