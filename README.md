
## Läroplanen
En interaktiv kunskapskarta för medieundervisning. Eleverna navigerar på en visuell nodkarta för att hitta sin läroväg, klickar på noder för att öppna övningar och arbetar sig igenom roller och projekt i sin egen takt.

## Vad det gör

Interaktiv karta — en zoombar och pannerbar SVG-canvas där varje nod representerar en roll eller ett projekt
Rollpaneler — ett klick på en nod öppnar en sidopanel med beskrivning, inbäddade YouTube-videos och nedladdningsbara övningsfiler
Projektstöd — projekt kan läsas in som JSON eller renderas som PDF direkt i panelen
Elevnavigering — en rullgardinsmeny låter lärare eller elever hoppa direkt till en namngiven elevs position på kartan
Styrplatta & touchstöd — nyp för att zooma och svep för att panorera, fungerar på både pekskärmar och bärbara datorers styrplattor


## Struktur
index.html              # Huvudapplikationen
map.svg                 # Kunskapskartan (laddas dynamiskt)
content/
  roles/                # JSON-filer för varje roll (t.ex. photoshop-1.json)
  projects/             # JSON- eller PDF-filer för projektuppgifter


## Innehållsformat
Varje roll är en JSON-fil i content/roles/:
json{
  "id": "role-photoshop-1",
  "title": "Photoshop Nivå 1",
  "type": "Roll",
  "yrkesinfo": "Beskrivning av rollen...",
  "exercises": [
    {
      "title": "Övningens titel",
      "description": "Vad eleven ska lära sig.",
      "video1": "https://youtu.be/...",
      "exercise_file_1": "https://...",
      "folderUrl": "https://..."
    }
  ],
  "outro": "Avslutande meddelande som visas efter alla övningar."
}


Nod-ID:n i map.svg måste matcha filnamnen — en nod med id role-photoshop-1 laddar content/roles/photoshop-1.json.

##Köra lokalt
Inget byggsteg krävs. Servera mappen med valfri statisk filserver, till exempel:
bashnpx serve .
python -m http.server
Öppna sedan http://localhost:3000 (eller den port som visas) i din webbläsare.

Kartredigering
Kartan är byggd i Adobe Illustrator och exporterad som SVG. Nod-element ska ha ett id-attribut som matchar mönstret role-[namn] eller project-[namn] för att vara klickbara. Illustrator kan lägga till dublettändelser (t.ex. -2) som appen automatiskt tar bort för rollnoder.


## Licens

© 2026 [Ditt namn]. Källkoden och innehållet får användas fritt av offentligt finansierade skolor och enskilda lärare för icke-kommersiella utbildningssyften. Kommersiellt bruk — inklusive användning av friskolor och vinstdrivande verksamheter — är förbjudet utan skriftligt tillstånd. Se [LICENSE](LICENSE) för fullständig text.






