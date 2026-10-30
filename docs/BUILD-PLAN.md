# AgentStudio: byggplan

Status: påbörjad 2026-10-30.

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

## Kvar

### Steg 3: Grindar som bygger på riktiga resultat (från Claude-Pipeline)
- Klart i steg 2: utvecklarens och testarens godkännande kräver att `run_checks` returnerar exitkod 0.
- Om allt är grönt görs inget modellanrop för att beskriva resultatet.
- Deterministiska kontroller körs före dyra agentsteg. Rena resultat kostar inga anrop. Ett objektivt fynd ger ett avgränsat anrop för att rätta det.
- En sista kontrollmatris körs efter bygget och efter varje automatisk åtgärd.

### Steg 4: Granskning och säkerhet
- Granskningen gäller den faktiska git-diffen. Merge sker bara vid `APPROVE`, med högst två automatiska åtgärdsförsök.
- Skanning av skyddade sökvägar, hemligheter, beroendekällor och symboliska länkar som pekar ut ur repot. Den kan inte undantas.
- Hemligheter maskeras i aktivitetsloggen och i dokument innan något sparas.
- Verifiering, säkerhet och granskning måste bekräfta samma git-träd innan merge.

### Steg 5: Starkare design och plan
- Kravsammanställning (requirements-crystallizer).
- Adversariell designkritik ur tre perspektiv innan designen godkänns.
- Plangranskning och kontroll av avvikelser mellan plan och design före bygget.

### Steg 6: Översättning och skärmdumpar
- Översätt resten av gränssnittet: guiden, item-lådan, agentsidorna, kostnadsvyerna och toasts.
- Ta om skärmdumparna i guiden (`web/public/guide/`) och i `docs/.attachments/`. De visar fortfarande det gamla Salesforce-utseendet.

## Kända saker
- Planen är för personligt bruk. Om flera personer ska använda appen, eller om den ska köra oövervakad hela tiden, behövs API-motorn enligt Anthropics villkor.
- En hel live-körning med alla sju agenter på planen mot ett riktigt repo är inte gjord än. Gör en generalrepetition med demorepot före en live-demo.
