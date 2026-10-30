# Plan: ny lösning med samma gränssnitt, driven av Agent SDK

Status: utkast · Skapad 2026-10-29

## 1. Mål

Bygga en ny app där **gränssnittet (`web/`) behålls** men där motorn bakom byts ut:

- Agenterna körs med **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) och använder din egen Claude-plan i stället för API-nyckel.
- Domänen (Salesforce, Azure DevOps, miljökedjor och så vidare) kan bytas mot något annat. Gränssnittets form (projekt, arbetsobjekt, agenter, körningar, aktivitetsflöde, kostnadsvyer) behålls.
- Det ska gå att byta tillbaka till API-nyckel senare utan omskrivning.

Användningen är personlig och för test. Om flera personer ska använda den, eller om den ska köra oövervakat hela tiden, behövs en API-nyckel enligt Anthropics villkor. Kontrollera villkoren innan det blir aktuellt.

## 2. Hur gränssnittet hänger ihop med servern

Det här avgör hela planen. Gränssnittet pratar med servern på två sätt:

1. **REST under `/api/*`.** Ungefär 82 endpoints, i `server/src/api.ts` och `server/src/routes/`. Typerna som gränssnittet förväntar sig står i `web/src/lib/api.ts` (`Project`, `WorkItem`, `Agent`, `Run`, `Activity`, `Meta`, `Estimate` och fler). Anropen görs med react-query (`web/src/lib/queries.ts`).
2. **Server-sent events på `/api/events`.** Tio händelsetyper: `project`, `item`, `run`, `activity`, `message`, `cost`, `document`, `file`, `question`, `agent`. `web/src/lib/live.ts` översätter dem till react-query-uppdateringar. Servern sidan finns i `server/src/events.ts` (40 rader).

**Slutsats:** att behålla gränssnittet betyder att behålla det här avtalet. Den nya servern behöver inte vara en kopia av den gamla, men den ska svara med samma former för de delar av gränssnittet du behåller.

## 3. Strategi

Bygg den nya lösningen som **en kopia av projektet som skalas ner**, inte som en blank sida.

- Kopiera hela mappen till ett nytt projekt.
- Behåll `web/` och det som hör till kärnan på servern: `db.ts`, `events.ts`, `app.ts`, `auth.ts`, `store.ts`, `agents/store.ts`, `agents/tools.ts`-strukturen och `orchestrator.ts`.
- Ta bort domänspecifika delar steg för steg (se avsnitt 5), och låt typkontrollen (`npm run typecheck`) visa vad som hänger kvar.
- Byt ut `agents/runner.ts` mot en SDK-baserad körning (se avsnitt 6).

Fördelen är att gränssnittet fungerar från första dagen. Du bygger om motorn medan sidan fortfarande går att öppna och testa.

## 4. Beslut att ta först

| Fråga | Alternativ | Min rekommendation |
|---|---|---|
| Vad ska den nya lösningen göra? | Fritt | Skriv det i en mening innan något annat görs |
| Vilka agentroller? | 2–4 stycken | Börja med färre än de sju som finns nu |
| Behålls pipelinen (steg, grindar, omarbetning)? | Ja / förenklad | Behåll grindar och omarbetningsgräns, de är billiga och användbara |
| Behålls Salesforce, ADO, git och miljöer? | Ja / nej | Nej, ta bort. De är mest kod och mest domän |
| Behålls kostnadsvyerna? | Ja / ersätt med tokenvyer | Ersätt: på en plan är dollar bara en mätare |
| Inloggning och användare? | Ja / nej | Nej för personligt bruk, men behåll koden avstängd |

## 5. Vad som behålls, ändras och tas bort

### Behålls som den är
- `web/` i sin helhet till att börja med: skal, sidor, grafvy, komponenter, `lib/`.
- `server/src/db.ts` (SQLite), `events.ts`, `app.ts`.
- Tabellerna för projekt, arbetsobjekt, dokument, körningar, aktivitet, meddelanden, frågor.
- Simuleringsläget (`agents/simulator.ts`): det gör att hela gränssnittet går att bygga utan att förbruka något.

### Ändras
- `agents/runner.ts`: ersätts av SDK-körning.
- `agents/tools.ts`: verktygen behålls som funktioner men exponeras via en MCP-server (avsnitt 6).
- `agents/roles.ts`: nya roller, prompter och kunskap.
- `agents/context.ts`: ny kontext per roll, samma mönster (delat block + specifikt block).
- `pricing.ts`, `pause.ts`: tokenmätare och planens gräns i stället för dollar och API-fel.
- `Meta`-svaret (`/api/meta`): gränssnittet läser `hasApiKey`, `models`, `spend` och `settings` därifrån. Behåll fälten, fyll dem med nya värden.

### Tas bort (domänspecifikt)
- `sf.ts`, `salesforce.ts`, `environments.ts`, `screenshots.ts`, `evidence.ts`
- `ado.ts`, `routes/ado.ts`
- `git.ts`, `github.ts`, `pullrequests.ts`, `review.ts`
- `estimate.ts`, `accuracy.ts` (eller förenkla)
- I gränssnittet: `Orgs`, `Environments`, `AdoSettings`, `Repo`, `EstimateAccuracy` och motsvarande flikar och rutter.

Ta bort i omgångar och kör typkontrollen efter varje. Gränssnittet har typer för allt detta i `lib/api.ts`, så rensa dem sist.

## 6. Agentmotorn med Agent SDK

### 6.1 Körningen
Skapa `agents/runner-sdk.ts` med samma signatur som `runAgent` har i dag, så att orkestratorn inte märker skillnaden. Inuti:

- Anropa `query({ prompt, options })` och läs strömmen med `for await`.
- Alternativ: `systemPrompt` från `buildSystemPrompt(agent)`, `model` från agenten, `maxTurns` från agentens `max_turns`, `abortController` kopplad till stoppsignalen.
- Stäng av SDK:ts inbyggda verktyg (Bash, Read, Write, och så vidare) och ladda inga inställningskällor. Agenterna ska bara kunna det du ger dem, och din egen CLAUDE.md ska inte läcka in.
- Varje meddelande i strömmen blir en rad i aktivitetsloggen (`logActivity`) och en `emit()` till gränssnittet, som idag.
- Om du skickar en PDF eller bilder behövs SDK:ts strömmande indata (content blocks).

### 6.2 Verktygen
- Behåll `TOOLS`-registret: namn, beskrivning, schema, hanterare.
- Skriv en liten adapter som gör varje verktyg till ett MCP-verktyg med `createSdkMcpServer` och `tool()`, filtrerat på `agent.tools`. SDK:t vill ha zod-scheman, så antingen konverteras JSON-schemana eller så skrivs adaptern en gång.
- Verktygens namn får prefixet `mcp__<server>__<verktyg>`. Håll prompterna fria från exakta namn, eller ta bort prefixet i loggen.

### 6.3 Mätning och gränser
- Använd användningen från strömmen och `result`-meddelandet för att fortsätta fylla `llm_calls`. Då fungerar kostnads- och tokenvyerna.
- Siffrorna i dollar är beräknade, inte fakturerade. Behandla budgeten som en mjuk spärr.
- Planens gräns känns igen på felmeddelandet. Utöka `pause.ts` så att det ger en paus ("gränsen nådd, fortsätt senare") och inte ett fel.

### 6.4 Enstaka anrop utan verktyg
`consultAgent` och `liveChat` blir `query()` med `maxTurns: 1`, eller lämnas på API:t tills vidare.

### 6.5 Växlingsbar backend
Inställning `backend: "claude-code" | "api"`. Båda implementerar samma gränssnitt (`runAgent`). Standardvärdet följer vad som finns: API-nyckel eller inloggning.

## 7. Kunskap och minne

- Behåll `knowledge/` som korta Markdown-filer per ämne. Varje agent listar vilka den använder.
- Lägg till ett levande dokument per projekt med lärdomar (`project_lessons`). QA och arkitekten lägger till en rad när omarbetning sker. Det går in i det delade blocket och cachas.
- Gör stora kunskapspaket läsbara på begäran: kort index i prompten och ett verktyg `read_knowledge(id)`.
- Sätt modell och ansträngning per roll. Starkast för arkitekt och utvecklare, billigast för skrivare och planerare.

## 8. Etapper

| Etapp | Innehåll | Klart när |
|---|---|---|
| 0 | Kopiera projektet, få det att starta i simuleringsläge | Gränssnittet öppnas och en simulerad körning går igenom |
| 1 | Ta bort Salesforce, ADO, git och miljöer, server och gränssnitt | `npm run typecheck` går igenom, inga döda flikar |
| 2 | Nya roller, prompter, kontext och tabeller för den nya domänen | Simuleringen visar nya roller och arbetsobjekt |
| 3 | `runner-sdk.ts` med en roll och ett verktyg, på riktigt | En körning går från gränssnittet till SDK och tillbaka, med aktivitet i flödet |
| 4 | Verktygsadaptern för alla verktyg, mätning, stopp och paus | Alla roller kan köra, stoppknappen fungerar, planens gräns ger en paus |
| 5 | Lärdomsdokument, kunskap på begäran, modell per roll | Samma uppgift kostar färre tokens, färre omarbetningar |
| 6 | Valfritt: `backend: "api"` som andra väg, tester med skenanrop | Båda vägarna går att välja och testas utan nätverk |

Ta etapperna i ordning. Etapp 0 och 1 ger dig ett fungerande gränssnitt att bygga mot. Etapp 3 är det stora beviset: går det inte att få en körning genom SDK:t, ändra planen innan något mer byggs.

## 9. Risker

- **Planens gränser delas med allt annat du gör i Claude Code.** Tunga körningar kan stänga ute dig en stund. Mät tokens per körning från början.
- **Villkor.** Personligt bruk fungerar. Delad eller oövervakad drift kräver API-nyckel.
- **Mindre kontroll.** Cache-brytpunkter, tänkande och refusal-fallback är API-parametrar och finns inte på samma sätt i SDK:t.
- **Gränssnittets typer är stora.** `lib/api.ts` bär mycket Salesforce-specifikt. Städa den sist, annars går typkontrollen sönder tidigt.
- **Modeller.** Din plan avgör vilka modeller som går att välja. `agent.model` kan behöva mappas.

## 10. Första konkreta steg

1. Kopiera projektmappen till ett nytt namn och starta den med `npm run dev`.
2. Skriv en mening om vad den nya lösningen ska göra, och lista 2–4 roller.
3. Börja etapp 1: ta bort `sf.ts`, `ado.ts` och `git.ts` och följ typfelen.
