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

**Vilket Claude-konto?** Under **Settings → Claude account** väljer du vilken Claude-inloggning live-agenterna använder:

- **This computer's login** (standard): samma konto som `claude` i terminalen på datorn.
- **Egna konton:** tryck **Add account**, ge kontot ett namn (t.ex. Jobb) och tryck **Sign in**. Webbläsaren öppnas och du loggar in. Välj rätt organisation, t.ex. ert Team, på inloggningssidan. Slå på **SSO** om företaget loggar in via single sign-on. Fungerar inte inloggningen i webbläsaren, använd **Sign in from a terminal**. Då öppnas ett terminalfönster där du kan klistra in koden som inloggningssidan visar.
- Markera kontot som ska användas. Bytet gäller från nästa agentkörning, och Claude Code i terminalen påverkas inte.
- Ett projekt kan använda ett annat konto under projektets **Settings → Claude account**.
- AgentStudio sparar ingen token. Inloggningen ligger i Claudes egna filer under `data/claude-accounts/`, som aldrig committas. **Settings → System check** visar vilket konto som är aktivt.

Kontrollera att ett jobbkonto får användas till det här, eftersom AgentStudio skickar projektets krav och kod till Claude.

Prenumerationen är för personligt bruk. Ska flera personer använda appen, eller ska den köra oövervakad hela tiden, behövs API-nyckeln enligt Anthropics villkor.

Projekt behåller det läge de skapades i. Ett simulerat projekt blir alltså inte live för att du byter läge efteråt.

## 4. Skapa ett projekt

Klicka på **New project** och fyll i:

1. **Krav:** ladda upp en PDF eller beskriv kraven i textfältet. Utan PDF används texten som krav. Med **Start from the requirements template** får du en färdig mall (`docs/requirements-template.md`) där vanliga beslut redan är ifyllda: stack, tidszon, inloggning, seed-data, CI och vad som ligger utanför. Varje standardval du behåller är en fråga mindre från agenterna.
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

**Beroenden installeras automatiskt.** Agenterna kan inte köra kommandon själva, så AgentStudio installerar beroendena innan kontrollerna körs, på storyns gren:

- **auto** (standard): kommandot väljs utifrån lockfilen. Det blir `pnpm install`, `yarn install` eller `bun install`, och annars `npm install`. Saknas lockfilen skapar `npm install` en `package-lock.json`.
- En ny eller ändrad lockfil committas med storyn. `node_modules` committas aldrig, även om repots `.gitignore` saknar raden.
- Har `package.json` och lockfilen inte ändrats sedan förra installationen hoppas steget över.
- Misslyckas installationen stoppas kontrollerna, och felet syns för utvecklaren och QA.
- Under **Settings → Checks** kan du ange ett eget kommando eller **off** för att stänga av steget.

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

**Vilka stories AgentStudio bygger:** varje story har en ägare, AgentStudio eller någon annan.
- I **Backlog** filtrerar du på *Byggs av*, *Tilldelad*, *Iteration*, *Status*, *Tagg* och *Typ* och söker i texten. Kryssa i stories (eller **Välj alla som visas**) och välj **Ge till AgentStudio** eller **Ge till någon annan**.
- **Gör detta till AgentStudios regel** sparar filtren för tilldelad, iteration och tagg. AgentStudio bygger då det som matchar, och regeln kontrolleras vid varje körning, så nya och omfördelade stories följer den. Stories du gett bort för hand behåller det.
- Någon annans stories byggs aldrig och håller inte projektet öppet. AgentStudios stories som bygger på dem väntar tills de är levererade.

**Merge efter granskning:** under projektinställningen **Merge** väljer du *Review PR: en person mergar*, eller per story i storylådan. När en story är klar öppnar AgentStudio pull requesten (inte som utkast), lägger QA:s utlåtande som kommentar och sätter storyn i **In Review** i stället för att merga. Stories som bygger på den väntar. AgentStudio kollar var 2:e minut och vid varje körning: en mergad PR gör storyn *Release Ready* och projektet fortsätter av sig självt, en stängd PR gör den *Blocked*. Utan GitHub får storyn en **Merga**-knapp.

**Begärda ändringar:** begär granskaren ändringar på PR:en blir storyn *Changes Requested*. I storylådan står granskningen och radkommentarerna i en ruta som du kan redigera eller skriva om. **Skicka till utvecklaren** startar en omarbetning på samma gren, QA testar igen och samma PR går tillbaka till granskning. Väljer du *Skicka till utvecklaren automatiskt* under **När en granskare begär ändringar** går kommentarerna till utvecklaren direkt.

**Importera ett projekt som redan pågår (Azure DevOps):** kryssa i *Backloggen finns i Azure DevOps: importera den* när du skapar projektet, eller välj **Importera från Azure DevOps** i **Backlog**. Ange organisation, projekt och vid behov area path, iteration och taggar. **Förhandsgranska** visar vad som skulle komma in, utan att spara något.
- Importen läser bara; inget i Azure DevOps ändras. Token är `AZURE_DEVOPS_PAT` i `.env`.
- Epics, features, stories, tasks och buggar kommer in med koder som `US-12146`, status, tilldelad, iteration, taggar, föräldrar och beroenden (länkar och raden *Depends on*). En ny import uppdaterar det som redan importerats.
- Klara item kommer in som levererade och byggs aldrig om. Någon annans pågående arbete visas som *In Progress*.
- Under *AgentStudio bygger det som är tilldelat* anger du namn, till exempel ditt eget. Det sparas som AgentStudios regel.
- Importerade stories mergas efter granskning. AgentStudios stories utan acceptanskriterier får en fråga till dig i stället för en gissning.
- Kravsteget (som börjar med en tom backlog) körs aldrig för ett importerat projekt.
- **Vid varje körning** hämtar AgentStudio först det som ändrats i Azure DevOps: nya, ändrade, omfördelade och klara item. Ändras en story som AgentStudio redan arbetar med får utvecklaren ändringen som en kommentar.
- **Bara det som ändrats i Azure DevOps** förs vidare. Varje work item sparas som Azure DevOps skickade det (en buffert), och nästa hämtning jämförs mot den. AgentStudios egna förfiningar skrivs därför inte över, och utvecklaren får bara de rader som ändrats (`+` och `-`), inte hela texten igen.
- **Beskrivningen delas upp** i storyns fält: user story, bakgrund, affärsregler, acceptanskriterier (med Givet/När/Så-scenarierna) och utanför omfånget. Mallrester som TBD och [fyll i] tas bort, och raden *Depends on* blir storyns beroenden. Varje agent läser då bara de delar den behöver.
- **Bara de fält som behövs** hämtas: titel, beskrivning, acceptanskriterier, poäng, tilldelad, iteration, taggar, status och förälder. Historik och liknande laddas aldrig ned.
- **Mappningen** räknas ut en gång från er tavla och sparas med projektet: vad varje status betyder (inte påbörjad, pågår, klar, struken), vart återskrivningen flyttar stories, och vilka fält som läses. Den visas under **Så mappas det** i importdialogen, där du kan rätta den eller låta den räknas ut igen.
- **Skriv tillbaka** (projektinställningar → Azure DevOps) är *Bara status* för ett importerat projekt: AgentStudio flyttar bara sina egna importerade user stories till motsvarande status på tavlan (till exempel Develop, Test, Done), bara framåt, var 2:e minut och vid varje körning. Inget skapas och inga andra fält ändras. *Bara läsa* ändrar ingenting; *Full synk* är den gamla synken.

**Tid och kostnad (Overview):** siffrorna är mätta, inte uppskattade.
- **Vart tiden gick:** projektets förflutna tid delas upp i när agenterna arbetade, när projektet väntade på dig (grindar och frågor), pausade för gränser (Claude-planens fönster, utgiftstak eller budget), pausades av dig, och övrigt (kontroller, merge och väntan). Varje ögonblick räknas en gång, även när flera lanes körs samtidigt. Väntan och pauser registreras från och med den här versionen; tidigare hamnar de under *Övrigt*.
- **Vart pengarna gick:** vad modellanropen kostade, uppdelat på levererade stories, pågående, stoppade (blockerade, avbrutna, borttagna) och arbete för hela projektet (analys, design, planering, release). Under det står hur mycket som gick till omarbetning, alltså rundor efter att QA, kodgranskningen eller kontrollerna skickat tillbaka en story, och hur stor andel av de testade storyerna som gick igenom första gången.
- **På Claude-planen** heter kostnaden **API-värde**: vad samma arbete hade kostat med API-priser. Själva planen betalar du som en fast avgift.
- **Mänsklig uppskattning** räknas från storypoängen (timmar per poäng under Settings, plus 35 %). Den är en uppskattning, inte en mätning.

**Stories som inte blev levererade:** projektet blir inte *Completed* så länge stories står kvar. När alla steg har körts stannar det i stället vid grinden **Undelivered items**, som listar varje story med orsaken: öppna frågor, *Blocked* eller att den väntar på en annan story. En story startar inte förrän de stories den bygger på är levererade.
- **Continue:** blockerade stories får ett nytt försök, och stories vars frågor har besvarats tas med. Därefter körs leverans och release igen.
- **Finish anyway:** projektet avslutas utan dem.

Ett avslutat projekt med stories kvar visar knappen **Reopen**, som tar tillbaka grinden.

**Så sparar AgentStudio tokens i leveransen:**
- **Grunduppgifter först.** En uppgift (task) i kategorin *devops* utan egna beroenden, till exempel "Set up repository skeleton and CI", levereras före allt annat. Alla andra stories väntar på den, eftersom de inte kan köra checkarna utan projektets grund.
- **Ett tomt repo byggs upp av en story i taget.** Så länge `main` saknar en projektfil (t.ex. `package.json`) eller checks att köra, levererar AgentStudio en story i taget, oavsett antalet lanes. En grunduppgift tas först om det finns en. Den första utvecklaren får i uppgift att sätta upp ett minimalt skelett med typecheck-, lint-, test- och build-skript. När den storyn är mergad hittas checkarna automatiskt, och resten körs med alla lanes. Det gäller även om analytikern inte skapade någon grunduppgift.
- **Ingen QA på ofärdigt arbete.** Om utvecklaren inte lämnar över storyn, till exempel för att checkarna fortfarande faller, hoppar AgentStudio över QA och skickar storyn direkt tillbaka till utvecklaren.
- **Tidigt stopp.** Faller samma check på samma sätt två gånger i rad blir storyn *Blocked* direkt, med ett meddelande till dig. Den behöver då troligen något den inte kan skapa själv: kod från en annan story, ett installationssteg eller ett beslut.
- **Ställer utvecklaren en fråga** väntar storyn på ditt svar i stället för att gissa i fler rundor.
- **Lärdomar.** När en story godkänns efter omtag skrivs det den skickades tillbaka för ner som en kort regel i dokumentet **Lessons learned** (fliken Documents). Utvecklaren, QA och arkitekten följer reglerna i varje senare story, så att samma misstag inte kostar ett nytt omtag. Live kostar det ett litet anrop per story med omtag, en story utan omtag kostar inget extra. Du kan redigera listan och lägga till egna regler med **Add lesson**; dina rader tas aldrig bort automatiskt. Stäng av med **Lessons learned** i projektinställningarna.
- **Installerade paket syns inte.** `node_modules` och liknande mappar visas aldrig för agenterna eller under **Code**, och de kommer inte med i ZIP-exporten. Långa fillistor kortas till 300 filer.

**Pausa och stoppa:** **Pause** låter pågående steg bli klara. **Pause all** högst upp pausar allt arbete.

**Köra om en story:** öppna storyn och välj att köra om den med feedback, så går den genom bygge, test och dokumentation igen.

## 7. Språk

Knappen **EN/SV** längst ner i sidomenyn byter gränssnittet mellan engelska och svenska. Valet sparas i webbläsaren. Menyer, översikten, Nytt projekt, projektsidan och inställningarnas huvuddelar är översatta. Text som saknar översättning, till exempel den inbyggda guiden, visas på engelska.

Språket i agenternas arbete (backlogg, dokument, kodkommentarer) styrs separat under **Settings → Team → Deliverables language**.

## 8. Demo

Repot har ett färdigt demoexempel: en liten uppgifts-API (`demo/task-tracker`) med riktiga tester, lint och bygge, och en kravtext (`demo/requirements.md`).

1. Skapa demorepot. Skriptet skriver ut adressen du ska använda:

   ```bash
   npm run demo
   ```

2. **New project:** klistra in adressen som **Git repository**, och klistra in innehållet i `demo/requirements.md` i **Context for the team** (eller ladda upp den som PDF).
3. Kontrollerna hittas automatiskt i demorepots `package.json`: `npm run lint`, `npm test` och `npm run build`.
4. För en snabb simulerad demo: sätt **Settings → General → Simulation speed** till runt `0.2`. För en live-demo: välj **Live** och **Plan**, och kör en generalrepetition först.

Börja om med en ren kopia med `npm run demo -- --reset`. För helt rena projektlistor stoppar du servern och tar bort mappen `data/`.

## 9. Agenterna och teamet

- **Agents:** ändra en agents modell, effort, verktyg, kunskapspaket och egna instruktioner. Varje ändring sparas som en ny version som går att återställa.
- **Settings → Team:** gemensamma konventioner (språk, grennamn, commit- och PR-mallar, granskningschecklista), kontrollerna och export/import av hela teamet som en fil.
- **Settings → Projects / Model prices:** standardvärden för nya projekt och de priser kostnadsberäkningarna bygger på.

## 10. Var data sparas

Allt ligger lokalt i mappen `data/`: databasen, uppladdade PDF:er och varje projekts repo och worktrees. Mappen ignoreras av git. Ta bort den för att börja om från noll med servern stoppad.

## 11. Felsökning

| Problem | Lösning |
|---|---|
| `EADDRINUSE` vid start | Port 4100 används redan. Stoppa den andra servern, eller sätt `PORT=4200` i `.env` |
| Live körs ändå som simulering | Backend är **API** men ingen nyckel finns. Välj **Plan**, eller lägg `ANTHROPIC_API_KEY` i `.env` |
| "Claude login failed" | Kör `claude /login` och tryck sedan **Resume** |
| Arbetet pausas med "plan's limit is reached" | Planens 5-timmars- eller veckogräns. Arbetet fortsätter själv när gränsen återställs |
| "Use an https:// or git@ URL" | Repo-adressen ska vara `https://`, `git@` eller `file:///` (tre snedstreck för en lokal mapp) |
| En story fastnar hos utvecklaren | Kontrollerna går inte igenom. Se storyns aktivitet för vilket kommando som fallerar och dess utskrift |
