# Worker endpoint för betyg: `POST /student/rate`

Sidan skriver aldrig direkt till Firebase, allt sparande går via Cloudflare Worker
(`aged-math-1ef5.jimbernstrom.workers.dev`). Betygen kräver därför **en ny route** i
Workern. Utan den visas stjärnorna i projektpanelen men det går inte att spara något
(eleven får "Kunde inte spara – försök igen").

## Datamodell

```
students/{studentKey}/ratings/{nodeId} = 1..5      (heltal)
```

Ligger bredvid `finished`, `requests` och `currentNode`, så det följer med den
`students.json` som sidan redan läser var 10:e sekund. Medelvärdet räknas ut i
webbläsaren (`ratings.js`), så ingen extra läsregel i Firebase behövs.

## Request

```json
{ "token": "<inloggningstoken>", "nodeId": "project-gd-logotyp", "rating": 4 }
```

Eleven tas från token, precis som i `/student/request`. Skicka inte `studentKey` från sidan.

## Regler som Workern ska kontrollera

1. Token är giltig och tillhör en **elev** (`@edu.orebro.se`). Lärare kan inte betygsätta.
2. `nodeId` börjar med `project-`.
3. `rating` är ett heltal 1–5.
4. `nodeId` finns i elevens `students/{key}/finished/projects`. Man får bara betygsätta
   projekt som läraren har godkänt som klara.
5. Skriv endast `students/{key}/ratings/{nodeId}`. Ett nytt betyg ersätter det gamla.

Svar: `200 {"ok": true}`. Vid fel: `400` (ogiltigt värde), `401` (ogiltig token),
`403` (inte elev / projektet är inte avklarat).

## Skiss

Anpassa funktionsnamnen till de hjälpare som redan finns i Workern (token-verifiering och
Firebase-skrivning). Namnen nedan är bara platshållare.

```js
if (url.pathname === '/student/rate' && request.method === 'POST') {
  const { token, nodeId, rating } = await request.json();

  const user = await verifyToken(token);                       // finns redan: ger { email, name } eller null
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!user.email.endsWith('@edu.orebro.se')) return json({ error: 'students_only' }, 403);

  const n = Number(rating);
  if (!/^project-[a-z0-9-]+$/.test(nodeId || '') || !Number.isInteger(n) || n < 1 || n > 5) {
    return json({ error: 'bad_request' }, 400);
  }

  const key = nameToKey(user.name);                            // samma nyckel som övriga /student/*-routes
  const finished = (await fbGet(`students/${key}/finished/projects`)) || [];
  const list = Array.isArray(finished) ? finished : Object.values(finished);
  if (!list.includes(nodeId)) return json({ error: 'not_finished' }, 403);

  await fbPut(`students/${key}/ratings/${nodeId}`, n);         // samma skrivhjälpare som övriga routes
  return json({ ok: true });
}
```

## Test

1. Logga in som elev som har ett avklarat projekt, öppna projektet, klicka på en stjärna.
2. Kontrollera att `students/{key}/ratings/{nodeId}` finns i Firebase.
3. Efter högst 10 sekunder (eller direkt för eleven själv) ska stjärnor synas ovanför projektets nod på kartan.
4. Försök betygsätta ett projekt som inte är avklarat: Workern ska svara 403.
