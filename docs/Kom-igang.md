# Kom igång med AgentStudio

AgentStudio är en webbapp som körs på din egen dator. Ett team med sju AI-agenter tar en kravbeskrivning och ett git-repo och levererar hela vägen till en release:

1. Analytikern skriver en backlogg.
2. Arkitekten förfinar den tekniskt.
3. Planeraren ordnar arbetet.
4. Utvecklaren bygger.
5. QA testar.
6. Skribenten dokumenterar.
7. Release-ansvarig släpper.

Du godkänner vid grindarna. Varje story måste klara projektets egna kontroller, som test, bygge och lint, innan den går vidare.

## 1. Det här behöver du

| Krävs | Version | Används till |
|---|---|---|
| Node.js | 22.5 eller senare | Servern och webbappen |
| git | 2.25 eller senare | En gren och worktree per story |
| Claude Code (`claude`) | Inloggad med `claude /login` | Live-läge på din Claude-prenumeration |

**Valfritt:**
- GitHub CLI (`gh`, inloggad med `gh auth login`): pull requests per story.
- En API-nyckel (`ANTHROPIC_API_KEY`): live-läge via Claude API i stället för prenumerationen.

Kontrollera inloggningen till Claude:

```bash
claude auth status
```

## 2. Installera och starta

Kör i mappen `AgentStudio`:

```bash
npm install
```

```bash
npm start
```

Öppna sedan **http://localhost:4100** i webbläsaren. Stoppa servern med `Ctrl+C` i terminalen.

`npm start` bygger webbappen och startar servern. Under utveckling kan du i stället använda `npm run dev`, som laddar om webbappen när du ändrar koden (webben på `:5173`, API:t på `:4100`).

Kontrollera att datorn är redo. Kommandot läser bara och kostar inget:

```bash
npm run doctor
```

Samma kontroll finns i appen under **Settings → System check**.

## 3. Simulering eller live

Appen startar alltid i **Simulation**.

| | Simulering | Live |
|---|---|---|
| Agenterna | Förinspelade, inget skickas till Claude | Riktiga Claude-anrop |
| Kontrollerna (`run_checks`) | Körs inte, räknas som godkända | Körs på riktigt i projektets mapp |
| Kostnad | Ingen | Plan-kvot eller API-kostnad |
| Bra till | Prova gränssnittet och flödet | Riktigt arbete |

Byt till live under **Settings → General → Mode**. Under **Claude backend** väljer du hur Claude nås:

- **Plan:** din Claude-prenumeration via `claude /login`. Användningen räknas mot planens gränser. När 5-timmars- eller veckogränsen nås pausas arbetet och fortsätter när gränsen återställs.
- **API:** nyckeln i `.env` (`ANTHROPIC_API_KEY=...`). Du betalar per token.
- **Auto:** API om det finns en nyckel, annars Plan.

Prenumerationen är för personligt bruk. Ska flera personer använda appen, eller ska den köra oövervakad hela tiden, behövs API-nyckeln enligt Anthropics villkor.

Projekt behåller det läge de skapades i. Ett simulerat projekt blir alltså inte live för att du byter läge efteråt.

## 4. Skapa ett projekt

Klicka på **New project** och fyll i:

1. **Krav:** ladda upp en PDF eller beskriv kraven i textfältet. Utan PDF används texten som krav.
2. **Projektnamn.**
3. **Git-repo:** en `https://`-, `git@`- eller `file:///`-adress. Agenterna arbetar i en lokal klon. Med **Push to origin** pushas story-grenar, `main` och release-taggar till repot med datorns egen git-inloggning. Annars stannar allt lokalt.
4. **Team:** vilka agenter som ska vara med. En mall (**template**) väljer roller och inställningar åt dig.
5. **Run settings:**
   - **Approval gates:** pausa för dig vid backlogg, plan och release.
   - **Parallel lanes:** hur många stories som byggs samtidigt.
   - **Budget:** projektet pausas när beloppet nås.
   - **Max QA rework:** hur många gånger QA får skicka tillbaka en story.

Till höger visas en **uppskattning** av kostnad och tid innan något körs. Klicka sedan på **Create & start**.

## 5. Kontrollerna (det viktigaste)

En story räknas inte som klar för att en agent säger det. Projektets egna kommandon måste gå igenom:

- Utvecklaren kör `run_checks` på storyns gren. Storyn går till QA först efter en godkänd körning.
- QA kör dem igen och kan bara godkänna efter en godkänd körning.
- Release-ansvarig kör dem på `main` med allt mergat. Releasen publiceras bara om de går igenom.

Kommandona hämtas i den här ordningen:

1. Projektets egna, under projektets **Settings → Checks**.
2. Teamets, under **Settings → Team → Checks**.
3. Annars skripten `typecheck`, `lint`, `test` och `build` i repots `package.json`.

Projektsidan visar hur många kontroller som gäller. **No checks** betyder att inga hittades. Lägg då till minst en, till exempel `npm test`, annars testas ingenting på riktigt.

## 6. Följa och styra arbetet

| Flik | Vad du ser och gör |
|---|---|
| **Overview** | Status, kostnad, tid, teamet och senaste aktivitet |
| **Board / Backlog** | Alla epics, features och stories. Klicka på en story för detaljer, tester och historik |
| **Network / Activity** | Vem som pratar med vem, och varje steg agenterna tar |
| **Documents** | Projektbrief, lösningsdesign, leveransplan, manual och changelog |
| **Code** | Grenar, commits och filer i projektets repo |
| **Release** | Klara stories, kontrollerna, smoke-tester och release notes |

**Vid en grind** står projektet på *Awaiting approval*. Svara på öppna frågor (**Questions**), granska och godkänn för att gå vidare.

**Pausa och stoppa:** **Pause** låter pågående steg bli klara. **Pause all** högst upp pausar allt arbete.

**Köra om en story:** öppna storyn och välj att köra om den med feedback, så går den genom bygge, test och dokumentation igen.

## 7. Agenterna och teamet

- **Agents:** ändra en agents modell, effort, verktyg, kunskapspaket och egna instruktioner. Varje ändring sparas som en ny version som går att återställa.
- **Settings → Team:** gemensamma konventioner (språk, grennamn, commit- och PR-mallar, granskningschecklista), kontrollerna och export/import av hela teamet som en fil.
- **Settings → Projects / Model prices:** standardvärden för nya projekt och de priser kostnadsberäkningarna bygger på.

## 8. Var data sparas

Allt ligger lokalt i mappen `data/`: databasen, uppladdade PDF:er och varje projekts repo och worktrees. Mappen ignoreras av git. Ta bort den för att börja om från noll med servern stoppad.

## 9. Felsökning

| Problem | Lösning |
|---|---|
| `EADDRINUSE` vid start | Port 4100 används redan. Stoppa den andra servern, eller sätt `PORT=4200` i `.env` |
| Live körs ändå som simulering | Backend är **API** men ingen nyckel finns. Välj **Plan**, eller lägg `ANTHROPIC_API_KEY` i `.env` |
| "Claude login failed" | Kör `claude /login` och tryck sedan **Resume** |
| Arbetet pausas med "plan's limit is reached" | Planens 5-timmars- eller veckogräns. Arbetet fortsätter själv när gränsen återställs |
| "Use an https:// or git@ URL" | Repo-adressen ska vara `https://`, `git@` eller `file:///` (tre snedstreck för en lokal mapp) |
| En story fastnar hos utvecklaren | Kontrollerna går inte igenom. Se storyns aktivitet för vilket kommando som fallerar och dess utskrift |
