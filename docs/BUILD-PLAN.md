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

## Kvar

### Steg 2: Gör verktyget generellt (ta bort Salesforce)
- Ta bort `salesforce.ts`, `sf.ts`, `environments.ts`, `screenshots.ts`, orgregistret, Salesforce-verktygen i `tools.ts`, kunskapspaketen `sf-*.md`, vyerna `Orgs` och `Environments`, och Salesforce-texten i rollerna.
- Ersätt `deploy_story` och `run_apex_tests` med `run_checks`. Den kör projektets egna kommandon för test, bygge, typkontroll och lint, som anges per projekt eller identifieras automatiskt som `detect-project.sh` gör i Claude-Pipeline.
- Låt `npm run typecheck` visa vad som fortfarande refererar till de borttagna delarna.

### Steg 3: Grindar som bygger på riktiga resultat (från Claude-Pipeline)
- Utvecklarens och testarens godkännande kräver att `run_checks` returnerar exitkod 0. Om allt är grönt görs inget modellanrop för att beskriva resultatet.
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

### Steg 6: Städning
- Byt namn från SiroccoARM till AgentStudio: `package.json`, logga, texter och `doctor`.
- Lägg till en kontroll i `doctor` för planmotorn: att `claude` är installerat och inloggat.
- Lägg till `.gitattributes` för radslut (LF).
- Höj tidsgränsen i e2e-testet. Pipelinen tar 58–60 sekunder på den här datorn, och gränsen är 60 sekunder.
- Uppdatera dokumentationen i `docs/`.

## Kända saker
- Planen är för personligt bruk. Om flera personer ska använda appen, eller om den ska köra oövervakad hela tiden, behövs API-motorn enligt Anthropics villkor.
- 14 tester faller redan i originalkoden på den här Windows-datorn. Det gäller bland annat validering av repo-URL:er för lokala sökvägar, `gh`-fixturer och doctor. De bör åtgärdas i steg 2 eller 6.
- Planmotorn är inte provkörd mot en riktig `claude`-inloggning ännu. Det kostar en liten del av planens kvot.
