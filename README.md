# Asistente telefónico con IA para restaurantes

Contesta llamadas en español, atiende dudas (horarios, carta, alérgenos), **reserva y cancela mesas**, pasa la llamada a una persona cuando hace falta y guarda cada llamada con su transcripción. Incluye un panel para el dueño en `/admin`.

**Cómo funciona:** Twilio recibe la llamada y envía el audio a este servidor; el servidor lo conecta con OpenAI Realtime (voz a voz) y ejecuta las acciones (comprobar disponibilidad, crear reserva…).

## Qué necesitas (cuentas)

1. **OpenAI** con crédito: https://platform.openai.com → API keys.
2. **Twilio**: https://www.twilio.com → compra un número (para España pueden pedir verificación de identidad/dirección; empieza con la cuenta de prueba).
3. **Un hosting** con Node 20+: Railway o Render (plan pequeño) sirven.

## Probarlo en tu ordenador (sin gastar en hosting)

```bash
npm install
cp .env.example .env      # rellena OPENAI_API_KEY y las de Twilio
npm test                  # comprueba que la lógica funciona
node --env-file=.env src/server.js
```

En otra terminal, expón tu ordenador a internet con ngrok (`ngrok http 5050`), copia la URL `https://xxxx.ngrok-free.app` en `PUBLIC_URL` (en `.env`) y reinicia el servidor.

En la consola de Twilio → tu número → **Voice Configuration → A call comes in → Webhook** → `https://xxxx.ngrok-free.app/incoming-call` (método POST). Llama al número y habla con el asistente.

> Con una cuenta de prueba de Twilio solo puedes llamar desde números que hayas verificado, y la llamada empieza con un aviso de Twilio.

## Desplegarlo (Railway como ejemplo)

1. Sube esta carpeta a un repositorio de GitHub (el `.gitignore` ya excluye `.env`).
2. En Railway: *New Project → Deploy from GitHub repo*.
3. En *Variables* pega las del `.env.example` con tus valores. `PUBLIC_URL` es la URL que te da Railway.
4. Añade un **Volume** montado en `/data` y pon `DATA_DIR=/data` (si no, las reservas se pierden en cada reinicio).
5. Pon la URL en el webhook de tu número de Twilio (`/incoming-call`).
6. Comprueba `https://tu-app/health` y entra en `https://tu-app/admin` (contraseña = `ADMIN_PASSWORD`).

## Adaptarlo a otro restaurante (o a otro negocio)

Todo el comportamiento sale de **`config/restaurant.json`**: nombre, dirección, horarios por día, aforo, duración de la mesa, preguntas frecuentes, saludo, voz y teléfono al que transferir (`phone_transfer`, con prefijo, p. ej. `+34600000000`). Para otro cliente, copia el archivo y arranca otra instancia con `BUSINESS_CONFIG=./config/otro.json`.

Para negocios que no sean restaurantes (clínica, peluquería…) hay que ajustar el texto de `src/prompt.js` y las herramientas de `src/tools.js`; la estructura sirve igual.

## Controlar los costes

- `MAX_CALL_SECONDS` corta las llamadas largas.
- `TRANSCRIBE=false` quita la transcripción.
- `OPENAI_REALTIME_MODEL`: prueba modelos más baratos de la familia realtime y compara la calidad en español con llamadas reales.
- Los mensajes cortos y directos del prompt ahorran minutos.
- Revisa los precios actuales en las páginas de OpenAI y Twilio antes de fijar tu cuota mensual al cliente.

## Seguridad

- `/incoming-call` valida la firma de Twilio (si defines `TWILIO_AUTH_TOKEN`).
- `/media-stream` solo acepta conexiones con un token firmado por el servidor.
- `/admin` pide contraseña. Usa siempre HTTPS (los hostings ya lo dan).

## Legal (España/UE)

- El asistente se presenta como asistente virtual al inicio (exigido por la normativa de IA en interacciones con personas).
- Las transcripciones contienen datos personales: informa al cliente en tu política de privacidad, limita el tiempo de conservación y ten un contrato de encargado de tratamiento con tu cliente (el restaurante).
- Este proyecto es solo para llamadas **entrantes**. Para llamadas salientes comerciales hace falta consentimiento previo. Consulta con un profesional para tu caso.

## Estructura

```
config/restaurant.json   datos del negocio
src/server.js            servidor, puente Twilio <-> OpenAI, panel /admin
src/prompt.js            instrucciones del asistente
src/tools.js             acciones: disponibilidad, reservar, buscar, cancelar, transferir, colgar
src/availability.js      horarios, aforo y alternativas
src/store.js             guardado en archivo JSON
src/twilio.js            firma, token de stream, colgar/transferir
test/                    pruebas (npm test)
```

## Limitaciones conocidas

- El almacenamiento en archivo JSON vale para un restaurante; para muchos clientes o varios servidores, cambia `store.js` por una base de datos.
- No se ha probado con una llamada real a Twilio/OpenAI desde aquí (necesita tus claves); las pruebas incluidas simulan ambos lados. La primera llamada real puede requerir ajustes de voz, silencios o nombre del modelo.
- Los nombres de modelo y de voz cambian con el tiempo: si OpenAI devuelve error de modelo, ajusta `OPENAI_REALTIME_MODEL`.
