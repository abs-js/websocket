# Simple Soccer Ball — servidor online (WebSocket)

Servidor de salas, rating estilo chess.com e apostas em moedas.

## Subir no Render

1. Crie uma conta em https://render.com
2. New → **Web Service**
3. Conecte o repositório (ou faça upload desta pasta `online-server`)
4. Preencha:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance:** Free
5. Em Environment **não** precisa setar `PORT` — o Render já envia.
6. Deploy. A URL fica assim: `https://SEU-SERVICO.onrender.com`
7. O WebSocket usa o **mesmo** endereço, só troca o protocolo:
   - site: `https://SEU-SERVICO.onrender.com`
   - jogo: `wss://SEU-SERVICO.onrender.com`

No jogo, cole essa URL em **Jogar online → Servidor**.

### Importante no plano Free
- O serviço **dorme** após ~15 min sem uso. O 1º jogador espera 30–60s o wake.
- Disco é temporário: o rating fica na memória + no save do jogador (localStorage).

### Testar local
```bash
cd online-server
npm install
node server.js
```
Abre `ws://localhost:3000`

## Apostas
`10000, 25000, 50000, 100000, 250000, 500000, 1000000`  
Amistoso = aposta 0, **não** mexe no rating.

## Pause
Partida online **não pausa**. Quem sai perde (wo).
