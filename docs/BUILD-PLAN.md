# AgentStudio: byggplan

Status: påbörjad 2026-10-30. Alla steg (1–6) klara 2026-11-02.

AgentStudio är en kopia av SiroccoARM (2026-10-27) som blir ett generellt verktyg för valfritt kodrepo. Det behåller SiroccoARM:s gränssnitt och leveranspipeline och lägger till kvalitetsgrindarna från Claude-Pipeline. Agenterna kan köras på din egen Claude-plan i stället för med en API-nyckel.

## Klart

### Steg 1: Motor på Claude-planen
- `server/src/agents/runner-sdk.ts` kör agenterna med Claude Agent SDK, som använder datorns `claude /login`.
  - Appens verktyg exponeras som en MCP-server i samma process. JSON Schema konverteras till zod.
  - Isolering: inga inbyggda verktyg (Bash, Read, Edit och liknande), inga inställningar, ingen CLAUDE.md, inga MCP-servrar från datorn och inga sparade sessioner. Behörighetsläget är `dontAsk`.
  - `ANTHROPIC_API_KEY` tas bort ur barnprocessens miljö, så att planen används och inte API-kontot.
  - När planens 5-timmars- eller veckogräns nås pausas arbetet till tiden då gränsen återställs. Om inloggningen misslyckas pausas arbetet och väntar på `claude /login`.
  - Projektets budget skickas med som `maxBudgetUsd`. Förbrukningen per modell sparas i `llm_calls`, så vyerna för kostnad och tokens fungerar som förut.
- Inställningen `backend` kan vara `auto`, `api` eller `subscription` och väljs under Inställningar → Execution. Auto använder API:t när det finns en nyckel, annars planen.
- Agentkörningar, konsultationer och chatt går via vald motor. Tokenräkning för PDF:er finns bara i API:t; på planen används appens uppskattning.
- Tester: `server/test/sdk.test.ts`, med en fejkad SDK. `test/setup.ts` stänger av planmotorn så att inga tester startar en riktig `claude`-process.

### Steg 2: Generellt verktyg (Salesforce borttaget)
- Borttaget: `sf.ts`, `salesforce.ts`, `environments.ts`, `screenshots.ts`, orgregistret och dess API, miljökedjan, Salesforce-verktygen (`describe_object`, `run_soql`, `deploy_story`, `run_apex_tests`, `run_anonymous_apex`, `build_manifest`, `validate_deployment`, `capture_screenshot`), kunskapspaketen `sf-*.md`, och vyerna `Orgs` och `Environments`.
- Nytt: `server/src/checks.ts` och verktyget `run_checks`. Det kör projektets egna kommandon i storyns worktree, eller på basgrenen vid release, och stoppar vid första fel.
  - Var kommandona kommer ifrån: projektets inställning, annars teamets, annars `package.json` (`typecheck`, `lint`, `test`, `build`).
  - I simulering körs ingenting.
- Grindar: `complete_development`, QA:s godkännande och `publish_release` kräver att `run_checks` har passerat i samma körning.
- Rollerna och kunskapspaketen är generella. Nya paket: `solution-architecture`, `engineering-standards` och `testing-standards`.
- Gränssnittet: Inställningar → Team → **Checks** och projektinställningar → **Checks** ersätter Salesforce-standarderna. Projektsidan och Releasevyn visar kontrollerna. Guidens avsnitt om orgar har ersatts med ett om kontroller.
- Tester: `server/test/checks.test.ts`, där kontrollerna körs på riktigt och grinden prövas.

### Demo-klart: generell simulator, namnbyte, språk och demomaterial
- Simulatorn bygger backloggen av kravtexten, även korta beskrivningar med *can*. Domänen är generell (entiteter som Task och Order i stället för Salesforce-objekt). Exempelscenariot är en uppgiftshanterare, och koden skrivs som TypeScript med tester.
- `test/live.test.ts` är omskriven: en inspelad Claude bygger kod, `node --test` körs på riktigt, fallerar först och går sedan igenom, och alla tre grindarna prövas.
- Namnbyte till AgentStudio: paket, logga, sidtitel, texter, guide och `docs/`. Gamla Salesforce-dokument är borttagna.
- Systemkontrollen (`doctor`) kollar `claude`-inloggningen när motorn är Plan. Kostnader märks som uppskattningar på planen.
- Gränssnittet går att växla mellan engelska och svenska (`web/src/lib/i18n.ts`, `sv.ts`).
- Demo: `demo/task-tracker` (riktiga tester, lint, bygge), `demo/requirements.md` och `npm run demo`.
- `.gitattributes` med LF. Rättade fel som hittades på vägen:
  - kunskapspaketens titlar lästes inte vid CRLF
  - kontroller sparades inte när ett projekt skapades
  - `node --test` som kontroll rapporterade inget när AgentStudio självt kördes under `node --test`

### Steg 3: Grindar som bygger på riktiga resultat (från Claude-Pipeline)
- **Attesteringar** (`server/src/attest.ts`, tabellen `attestations`): varje kontrollkörning sparas med exakt det git-träd den kördes på, oavsett om det var en agents `run_checks` eller orkestratorns egen körning. `verify()` kör kontrollerna utan modell och återanvänder ett resultat för samma träd. En ändrad fil gör resultatet ogiltigt.
- **Grön kod kostar inga extra anrop:** överlämning, QA:s godkännande och `publish_release` godtar kontroller som redan gått igenom på exakt samma kod. Ingen agent behöver köra om dem eller beskriva ett grönt resultat. Release-agenten får resultatet i sin uppgift och lägger in det i release notes.
- **Deterministiskt före dyra steg:**
  - Kontrollerna körs före QA. Är de röda går storyn tillbaka till utvecklaren utan något QA-anrop.
  - Kontrollerna körs på `main` före release. Är de röda får utvecklaren ett avgränsat rättningsanrop, högst två, och release-agenten anropas inte förrän de är gröna.
- **Slutlig kontrollmatris:** körs på exakt det som mergas, efter dokumentationen och efter att GitHubs `main` tagits in. Varje rättning följs av en ny körning. Är det fortfarande rött efter två rättningar blir storyn Blocked.
- Tester: `server/test/deterministic.test.ts`.
  - Återanvändning per träd.
  - Kod som ändras efter gröna kontroller går tillbaka utan QA-anrop.
  - En röd `main` rättas före release, eller stoppar releasen utan release-anrop.

### Steg 4: Granskning och säkerhet
- **Kodgranskningen** gäller storyns faktiska git-diff, och utslaget sparas som en attestering för det träd som granskades.
  - När projektet granskar (Complex eller All) sker merge bara vid `APPROVE`, med högst två automatiska rättningar efter granskningen.
  - Nya projekt får Complex som standard. Off finns kvar som val.
- **Säkerhetsskanning** (`server/src/scan.ts`) före varje merge. Den kan inte stängas av. Den hittar:
  - hemligheter i tillagda rader (nycklar, tokens, privata nycklar, hårdkodade lösenord)
  - skyddade sökvägar: `.env` (men inte `.env.example`), nycklar och certifikat, `.npmrc` och andra filer med inloggningsuppgifter, plus projektets egen lista `protectedPaths`
  - beroenden från något annat än paketregistret (git, URL:er, lokala sökvägar, andra index)
  - symboliska länkar som pekar ut ur repot

  Ett fynd ger ett avgränsat rättningsanrop med fynden, högst två. Därefter blir storyn Blocked. Ett fynd upprepar aldrig själva hemligheten.
- **Maskering** (`server/src/secrets.ts`): hemligheter ersätts med `[redacted: …]` i databaslagret innan något sparas. Det gäller aktivitet, meddelanden, kommentarer, dokument, testresultat, frågor och svar, körningar, release notes och storyernas fält.
- **Samma träd:** merge-grinden kräver att kontrollerna, skanningen och (när den gäller) granskningen är attesterade för exakt det träd som mergas. Ändringar i bara dokumentation efter granskningen kräver ingen ny granskning. Annan ny kod granskas om innan merge.
- Tester: `server/test/security.test.ts`.
  - Hemlighetsmönster, platshållare och maskering vid lagring.
  - Skanningens fyra slags fynd.
  - En hemlighet i en story: en rättning och sedan merge, eller två misslyckade rättningar och Blocked.

### Steg 5: Starkare design och plan
- **Kravsammanställning:** analytikern skriver först dokumentet `requirements_brief`. Där står mål, vad som ingår och inte ingår, aktörer och behörigheter, beteenden med kantfall, begränsningar, beroenden, antaganden (markerade som antaganden) och öppna frågor grupperade per tema. Bara det som ändrar vad som byggs frågas med `ask_human`. Backloggen byggs sedan från dokumentet: varje beteende som ingår täcks av en story, och inget som ligger utanför kommer med.
- **Adversariell designkritik** efter den tekniska förfiningen, före planeringen. Kritikern är QA när den finns i teamet, så att det inte är arkitekten som granskar sitt eget arbete.
  - Kritiken görs i ett anrop ur tre perspektiv: arkitektur; säkerhet och data; leverans och testbarhet.
  - Kritikern skriver dokumentet `design_critique` och anropar `submit_design_critique` med `approved` eller `revise`. Vid `revise` reviderar arkitekten designen och berörda storyer en gång.
  - Det är en projektinställning, **Design critique**, som är på som standard.
- **Plangranskning och avvikelsekontroll** efter planeringen, deterministiskt (`planFindings`). Den hittar:
  - beroenden som inte finns eller går i cirkel
  - stories som planeras före ett beroende
  - stories över 8 poäng
  - stories utan numrerade AC eller utan teknisk specifikation
  - en saknad lösningsdesign

  Bara fynd kostar anrop: planeraren rättar ordning, storlek och beroenden, och arkitekten rättar luckor i designen, en runda var. Det som återstår sparas i dokumentet `plan_review` och visas vid godkännandet av planen.
- Tester:
  - `live.test.ts`: kravsammanställningen och kritiken med tre perspektiv körs, av QA.
  - `guards.test.ts`: plangranskningens fynd.

### Steg 6: Översättning och skärmdumpar
- **Guiden:** när gränssnittet är på svenska visar Guide den svenska guiden `docs/Kom-igang.md` (via `GET /api/guide/sv`), med en knapp för att läsa den engelska. Den engelska guiden är oförändrad.
- **Översatt:** story-lådan (flikar, avsnittsrubriker, knappar och texter), agentsidan, agent-editorn och kostnadsvyerna har `t()` och svenska texter.
- **Toasts:** `toast()` översätter fasta meddelanden centralt. Meddelanden med variabler och fel från servern visas på engelska.
- **Skärmdumparna:** de visade Salesforce-utseendet och är borttagna, enligt beslut 2026-11-02, i stället för att tas om. Det gäller filerna i `web/public/guide/` och `docs/.attachments/`, guidens komponenter för bild och förstoring och bildlänkarna i `docs/`. `docs/Development.md` beskriver hur nya tas om de behövs.

### Steg 7: Lärdomar per projekt
Ett kort dokument per projekt, `project_lessons`, med det som QA, kodgranskningen och checkarna lärde en story, så att senare stories gör rätt första gången. Målet är färre omtag, det dyraste steget som upprepas i leveransen.
- **Format** (`server/src/lessons.ts`): en Markdown-punkt per lärdom, nyast sist, med källa i slutet: `(US-121, qa)` eller `(product owner)`. Högst 20 lärdomar på 200 tecken. När listan är full går den äldsta automatiska; produktägarens tas aldrig bort automatiskt.
- **I prompterna:** `lessonsBlock()` i `contextFor()` lägger lärdomarna (utan källor) i den delade, cachade delen för utvecklaren, QA och arkitekten. QA kontrollerar också att storyn följer dem.
- **Redigera för hand:** `PUT /api/projects/:id/lessons` med auditrad, och en editor med **Add lesson** under Documents.
- **Skrivs automatiskt:** leveransloopen loggar varje omtag (QA, kodgranskning, checkar). Efter godkännande anropar den `captureLessons()`: i simulering blir första fyndet en lärdom utan anrop; live görs ett anrop utan verktyg på låg effort som QA-agenten, sparat i `llm_calls` med steget `lessons`. Högst två lärdomar per story, nästan-dubbletter och sådant som bara gäller storyn sållas bort. Ett fel stoppar aldrig storyn.
- **Inställning:** **Lessons learned** i projektinställningarna (på som standard), svenska texter i `sv.ts`.
- Tester: `lessons.test.ts` (format, gränser, prompter, API, live-anropet med en skriptad modell, maskning av hemligheter, avstängt), `e2e.test.ts` (en lärdom efter omtag i simulering).
- **Kvar:** en mätkörning live, samma krav två gånger med och utan lärdomar, och jämför omtag per story utanför de stories som fastnade.

## Kvar

- Mätkörningen för lärdomar (steg 7).

## Kända saker
- Delar av gränssnittet är fortfarande bara på engelska: inställningssidorna, flera hjälptexter (`help=`) och dynamiska meddelanden.
- Planen är för personligt bruk. Om flera personer ska använda appen, eller om den ska köra oövervakad hela tiden, behövs API-motorn enligt Anthropics villkor.
- En hel live-körning med alla sju agenter på planen mot ett riktigt repo är inte gjord än. Gör en generalrepetition med demorepot före en live-demo.
