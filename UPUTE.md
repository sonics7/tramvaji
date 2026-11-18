# Tramvaji – red vožnje

Web-aplikacija za iPhone i Android koja za odabrane tramvaje i autobuse prikazuje
**sljedeća tri polaska** s odabrane stanice, uživo (kao ZET ploča na iPadu).

- Linije spremaš u **grupe** (npr. *Od kuće*, *S posla*) i prebacuješ se karticama na vrhu.
- Svaki mobitel ima **svoje** postavke (tvoj iPhone, tvoj Galaxy A55, suprugin A54 – neovisno).
- Zelena točka = podatak uživo (s kašnjenjem), siva = po voznom redu.
- **Obavijesti ZET-a:** kad ZET objavi izvanrednu obavijest (žuti okvir na naslovnici zet.hr) ili izmjenu
  na nekoj od tvojih linija, pri dnu se pojavi traka. Dodir na traku otvara cijelu vijest; ✕ je sakrije.
  Sve trenutne izmjene u prometu uvijek su pod 📢 gore desno (broj = nepročitane).
- Ne istječe nakon 7 dana i ne treba Xcode: dodaje se na početni zaslon iz preglednika.

## Kako radi

| Dio | Gdje | Što radi |
|---|---|---|
| `app/` | GitHub Pages (besplatno) | sama aplikacija |
| `build/build-data.js` | GitHub Actions, svaku noć ~2:20 | skine ZET-ov vozni red (GTFS) i pripremi male datoteke po stanici |
| `build/make-icons.py` | GitHub Actions | izradi ikone aplikacije |
| `worker/worker.js` | Cloudflare Workers (besplatno) | prosljeđuje ZET-ove podatke uživo (`/rt`) i obavijesti (`/vijesti`) mobitelu (ZET ih ne da izravno pregledniku) |

Isti izvori kao u Obiteljskom info centru: `zet.hr/gtfs-scheduled/latest` i `zet.hr/gtfs-rt-protobuf`,
ali za sve stanice i linije, i bez kućnog računala.

---

## Postavljanje (jednom, ~15 minuta)

### 1. Cloudflare Worker (podaci uživo)
1. Prijavi se ili otvori besplatni račun na <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker** (predložak *Hello World*), naziv npr. `zet-uzivo` → **Deploy**.
3. **Edit code** → obriši sve, zalijepi cijeli sadržaj `worker/worker.js` → **Deploy**.
4. Zapiši adresu, npr. `https://zet-uzivo.TVOJE-IME.workers.dev`.
   Provjera: otvori tu adresu + `/rt` u pregledniku – treba se skinuti datoteka (to je dobro),
   a adresa + `/vijesti` treba pokazati obavijesti ZET-a (tekst u JSON obliku).
5. U `app/config.js` upiši:
   ```js
   rtUrl: 'https://zet-uzivo.TVOJE-IME.workers.dev/rt'
   ```

### 2. GitHub (aplikacija i noćno osvježavanje voznog reda) – već postavljeno
- Repozitorij: <https://github.com/sonics7/tramvaji> (javan – GitHub Pages je besplatan samo za javne).
- **Settings → Pages → Source: GitHub Actions** je uključeno.
- Aplikacija: **<https://sonics7.github.io/tramvaji/>**
- Svaku noć oko 2:20 i nakon svake promjene GitHub sam skine vozni red, izradi ikone i objavi
  aplikaciju (Actions → *Objava*). Ručno: Actions → Objava → **Run workflow**.

Izmjena datoteke (npr. `app/config.js`): na GitHubu otvori datoteku → olovka (Edit) → promijeni →
**Commit changes**. Za minutu-dvije je objavljeno.

Ako želiš slati promjene s Maca preko Terminala:
```bash
cd ~/"Library/CloudStorage/OneDrive-Personal/All Devices/Projekti/Tramvaji_red_voznje"
git init -b main && git remote add origin https://github.com/sonics7/tramvaji.git
git fetch origin && git reset --mixed origin/main     # jednom, da se mapa poveže s repozitorijem
git add . && git commit -m "opis promjene" && git push
```

### 3. Na mobitele
- **iPhone (Safari):** otvori adresu → gumb Dijeli → **Dodaj na početni zaslon**.
- **Android (Chrome):** otvori adresu → ⋮ → **Instaliraj aplikaciju** / Dodaj na početni zaslon.

Supruga isto na svom A54 – njene grupe i linije su samo njene.

---

## Korištenje
- **✎** (gore desno) → uredi grupu: naziv, redoslijed linija (▲▼), brisanje (✕), nove grupe.
- **＋ Dodaj liniju**:
  - *Tramvaji* / *Autobusi* → broj linije → smjer → stanica (📍 *Označi najbližu* pronađe stanicu po lokaciji), ili
  - *Po stanici* → upiši naziv ili 📍 *Najbliže stanice* → sve linije koje tamo staju.
- Minute: veliki broj je prvi polazak, zatim sljedeća dva. „sada” = manje od minute; ako je
  polazak za više od sat vremena, piše se točno vrijeme (npr. 5:12).
- **Prijenos na drugi mobitel:** *Kopiraj / pošalji kod* → pošalji poruku → na drugom mobitelu
  zalijepi kod u polje i *Uvezi grupe iz koda*. Nakon toga svatko uređuje svoje.

## Ako nešto ne radi
- **Nema trake/📢 s obavijestima**: obavijesti dolaze preko istog Workera, pa trebaju upisan `rtUrl`.
  Ako se `worker.js` promijeni, ponovno ga zalijepi u Cloudflare (Edit code → Deploy).
  Traka se pojavljuje samo za izvanredne obavijesti, izmjene na tvojim linijama i opće obavijesti iz zadnja 4 dana.
- **Siva točka i „Uživo nedostupno”**: provjeri adresu u `config.js` (mora završavati s `/rt`) i
  otvori je u pregledniku. Ako ZET kratko ne radi, aplikacija prikazuje vozni red.
- **Akcija „Objava” javlja grešku pri skidanju sa zet.hr**: ZET je možda blokirao GitHubove
  poslužitelje. Ako je Worker postavljen i `rtUrl` upisan, skripta sama pokuša preko Workera
  (`/gtfs`). Pokreni ponovno: Actions → Objava → Run workflow.
- **Promjena izgleda ne vidi se odmah na mobitelu**: zatvori i ponovno otvori aplikaciju (dvaput).

## Lokalni test na Macu
```bash
node build/build-data.js app/data        # skine vozni red (~1 min)
cd app && python3 -m http.server 8000    # pa otvori http://localhost:8000
```
