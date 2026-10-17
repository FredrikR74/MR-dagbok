# Dagboken

En mobilanpassad webbsida för att läsa, söka i och skriva i dagboken som ligger i ett Google Sheet.
Sidan körs på GitHub Pages, men **ingen dagbokstext finns i koden**. Allt hämtas direkt från
kalkylarket när man har loggat in med sitt Google-konto, och bara konton som har åtkomst till
kalkylarket kan läsa det.

## Funktioner

- Tidslinje grupperad per månad, filter per år och "Den här dagen tidigare år"
- Snabb fritextsökning (i text, ort, väder och datum) med markerade träffar
- Läsvy med stora bokstäver: bläddra med knapparna eller svep åt sidan
- Ny anteckning och redigering, med fet, kursiv, understruken och genomstruken text
- Ny anteckning fyller i ort och väder från telefonens position automatiskt
- Textstorlek (Aa uppe till höger) från liten till mycket stor, och ljust eller mörkt läge
- Osparad text sparas som utkast i telefonen, så inget försvinner om inloggningen gått ut
- Kan läggas på hemskärmen som en app

## Kolumner i kalkylarket

Första fliken används, och rad 1 räknas som rubriker.

| Kolumn | Innehåll | Vid ny anteckning |
|---|---|---|
| A | Tidsstämpel (när anteckningen skrevs) | Fylls i automatiskt |
| B | Datum | Dagens datum, går att ändra |
| C | Väder | Hämtas från Open-Meteo, t.ex. "Sol, 22°" |
| D | Text (rich text) | Formateringen sparas |
| E | Ort | Hämtas från telefonens position |

> Om man redigerar en gammal anteckning som har färgad text eller annan teckenstorlek i
> kalkylarket behålls bara fet, kursiv, understruken och genomstruken.

## Installation (görs en gång)

### 1. Google Cloud: skapa ett Client ID

1. Gå till <https://console.cloud.google.com/> och logga in, gärna med samma Gmail som äger dagboken.
2. Skapa ett nytt projekt, t.ex. **Dagbok**.
3. **APIs & Services → Library**: sök på **Google Sheets API** och klicka **Enable**.
4. **Google Auth Platform** (kallas ibland *OAuth consent screen*) → **Get started**:
   - App name: `Dagboken`, och ange din e-post som support- och kontaktadress.
   - Audience: **External**.
5. Under **Audience → Test users**: lägg till din frus Gmail-adress. Låt appen ligga kvar i läget
   **Testing**. Då behövs ingen granskning från Google, och bara testanvändarna kan logga in.
6. Under **Clients → Create client**:
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `https://DITT-GITHUBNAMN.github.io`
     - `http://localhost:8000` (för att testa lokalt)
   - Kopiera **Client ID** (slutar på `.apps.googleusercontent.com`).
7. Öppna `config.js` och klistra in Client ID i `clientId`.

### 2. GitHub Pages

1. Skapa ett repo på GitHub, t.ex. `dagbok`. Det kan vara publikt, för koden innehåller inget privat.
2. Ladda upp filerna (inte mappen `.claude`):
   ```bash
   git init && git add index.html styles.css app.js config.js manifest.webmanifest icon.svg icon-180.png icon-512.png README.md && git commit -m "Dagboken"
   ```
   ```bash
   git branch -M main && git remote add origin https://github.com/DITT-GITHUBNAMN/dagbok.git && git push -u origin main
   ```
3. På GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)**.
4. Efter någon minut finns sidan på `https://DITT-GITHUBNAMN.github.io/dagbok/`.

### 3. I telefonen

1. Öppna adressen och tryck **Logga in med Google**.
2. Google varnar för att appen inte är verifierad (*"Google hasn't verified this app"*). Det är
   normalt för privata appar: tryck **Fortsätt** och kryssa i att sidan får se och redigera kalkylark.
3. Klistra in länken till dagbokens kalkylark. Den sparas bara i telefonen.
4. Lägg sidan på hemskärmen:
   - iPhone: dela-knappen → **Lägg till på hemskärmen**
   - Android: menyn → **Lägg till på startskärmen**
5. Tillåt platsåtkomst första gången hon skriver en ny anteckning, så fylls ort och väder i.

Inloggningen från Google gäller en timme åt gången. Efter det visar sidan den sparade kopian och
en knapp för att logga in igen. Inloggningen går också automatiskt när man trycker Spara.

## Testa lokalt

```bash
npx http-server@14.1.1 -p 8000 -c-1
```

- <http://localhost:8000/?demo> visar påhittade exempelanteckningar, utan inloggning.
- <http://localhost:8000/> använder det riktiga kalkylarket (kräver att `http://localhost:8000`
  finns bland Authorized JavaScript origins).

## Integritet

- Dagboken lagras bara i Google Sheets. En kopia sparas i telefonens webbläsare så att sidan
  startar snabbt, och den raderas om man trycker **Logga ut**.
- Vid ny anteckning skickas telefonens ungefärliga position till Open-Meteo (väder) och
  BigDataCloud (ortnamn). Inget annat skickas till dem.
- Sidan har `noindex`, så sökmotorer listar den inte.
