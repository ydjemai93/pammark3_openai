require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
const axios = require("axios");
const { spawn } = require("child_process");

// Twilio Configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (accountSid && authToken) {
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log(`[${new Date().toISOString()}] Twilio client OK: ${accountSid}`);
} else {
  console.warn("Twilio credentials missing => no outbound calls");
}

// Deepgram Configuration
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// OpenAI Configuration
const OpenAI = require("openai");
const openai = new OpenAI();

// Configuration TTS via OpenAI Audio API en streaming realtime TTS HD
const TTS_MODEL = "tts-1-hd";
const TTS_VOICE = "alloy";

// Conversation Settings & Prompts
const systemMessage = "Tu es Pam, un agent de call center intelligent et accessible, doté d’une large palette de compétences : gestion des appels, support client, assistance technique et aide à la vente. Ta manière de communiquer doit rester conviviale et naturelle, sans répéter mécaniquement tes fonctionnalités.";
const initialAssistantMessage = "Bonjour, ici Pam. Merci d’avoir pris contact. Comment puis-je vous aider aujourd’hui ?";

// On n'injecte le message système et initial qu'une seule fois au début.
const BASE_CONVERSATION = [
  { role: "system", content: systemMessage },
  { role: "assistant", content: initialAssistantMessage }
];

const CONVERSATION_HISTORY_LIMIT = 4;
const PORT = process.env.PORT || 8080;
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"];

// Flags globaux pour gérer le TTS
let speaking = false;
let ttsAbort = false;

//------------------------------------------
// Serveur HTTP
//------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running.");
  }
  if (req.method === "POST" && pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }
  if (req.method === "POST" && pathname === "/twiml") {
    try {
      const filePath = path.join(__dirname, "templates", "streams.xml");
      let streamsXML = fs.readFileSync(filePath, "utf8");
      let serverUrl = process.env.SERVER || "localhost";
      serverUrl = serverUrl.replace(/^https?:\/\//, "");
      streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);
      console.log(`[${new Date().toISOString()}] streams.xml généré : ${streamsXML}`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(streamsXML);
    } catch (err) {
      console.error("Error reading streams.xml:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error (twiml)");
    }
  }
  if (req.method === "POST" && pathname === "/outbound") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.to) throw new Error("'to' missing");
        if (!twilioClient) throw new Error("Twilio not configured");

        let domain = process.env.SERVER || "";
        if (!domain.match(/^https?:\/\//)) {
          domain = `https://${domain.replace(/^\/|\/$/g, "")}`;
        }
        const twimlUrl = `${domain}/twiml`;
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661";
        console.log(`[${new Date().toISOString()}] Calling to: ${parsed.to} Twiml URL: ${twimlUrl}`);
        const call = await twilioClient.calls.create({
          to: parsed.to,
          from: fromNumber,
          url: twimlUrl,
          method: "POST",
          timeout: 15
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, callSid: call.sid }));
      } catch (err) {
        console.error("Outbound error:", err);
        res.writeHead(err.status || 500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

//------------------------------------------
// WebSocket Server
//------------------------------------------
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});
wsServer.on("request", (request) => {
  if (request.resourceURL.pathname.startsWith("/streams")) {
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
  }
});

//------------------------------------------
// Classe MediaStream
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.streamSid = "";
    this.active = true;
    // Historique initial avec le contexte de base
    this.conversation = [...BASE_CONVERSATION];
    console.log(`[${new Date().toISOString()}] Conversation initiale:`, JSON.stringify(this.conversation, null, 2));
    this.inputDebounceTimer = null; // Pour regrouper les inputs utilisateur
    this.setupDeepgram();
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.connection.on("message", (message) => {
      if (message.type === "utf8") {
        const data = JSON.parse(message.utf8Data);
        this.handleProtocolMessage(data);
      }
    });
    this.connection.on("close", () => {
      this.active = false;
      this.deepgram.finish();
      console.log(`[${new Date().toISOString()}] Connection closed`);
    });
  }

  handleProtocolMessage(data) {
    switch (data.event) {
      case "media":
        if (data.media.track === "inbound") {
          if (!this.streamSid) this.streamSid = data.streamSid;
          this.processAudio(data.media.payload);
        }
        break;
      case "start":
        this.startConversation();
        break;
      default:
        break;
    }
  }

  async startConversation() {
    await this.speakWithDelay(initialAssistantMessage, 1000);
  }

  async processAudio(payload) {
    try {
      const rawAudio = Buffer.from(payload, "base64");
      this.deepgram.send(rawAudio);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Audio processing error:`, err);
    }
  }

  async speak(text) {
    if (!this.active) return;
    try {
      const audioBuffer = await this.synthesizeSpeech(text);
      if (ttsAbort) {
        console.log(`[${new Date().toISOString()}] speak => TTS abort triggered, skipping audio send`);
        return;
      }
      const mulawBuffer = await this.convertAudio(audioBuffer);
      if (ttsAbort) return;
      this.sendAudioChunks(mulawBuffer);
      console.log(`[${new Date().toISOString()}] Spoken: "${text}"`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] TTS error:`, err);
    }
  }

  // --- Utilisation de l'API Audio d'OpenAI pour le streaming realtime TTS HD ---
  async synthesizeSpeech(text) {
    const speechResponse = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
    });
    const arrayBuffer = await speechResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async convertAudio(mp3Buffer) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-ar", "8000",
        "-ac", "1",
        "-f", "mulaw",
        "pipe:1"
      ]);
      const chunks = [];
      ffmpeg.stdout.on("data", chunk => chunks.push(chunk));
      ffmpeg.on("close", code => code === 0 
        ? resolve(Buffer.concat(chunks)) 
        : reject(new Error(`FFmpeg error ${code}`))
      );
      ffmpeg.stdin.write(mp3Buffer);
      ffmpeg.stdin.end();
    });
  }

  sendAudioChunks(buffer, chunkSize = 4000) {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const chunk = buffer.slice(offset, offset + chunkSize);
      this.connection.sendUTF(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunk.toString("base64") }
      }));
    }
  }

  setupDeepgram() {
    this.deepgram = deepgramClient.listen.live({
      model: "nova-2",
      language: "fr-FR",
      endpointing: 300,
      interim_results: false,
      encoding: "mulaw",
      sample_rate: 8000
    });
    this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      if (data.speech_final && data.is_final) {
        const transcript = data.channel.alternatives[0].transcript;
        console.log(`[${new Date().toISOString()}] Deepgram Transcript: "${transcript}"`);
        this.handleUserInput(transcript);
      }
    });
  }

  async handleUserInput(transcript) {
    if (!this.active) return;
    // Filtrer les messages vides ou trop courts (<2 caractères)
    if (transcript.trim().length < 2) {
      console.log(`[${new Date().toISOString()}] Ignoring empty or too short transcript`);
      return;
    }
    console.log(`[${new Date().toISOString()}] User input received: "${transcript}"`);
    ttsAbort = true;
    await this.sleep(200);
    this.conversation.push({ role: "user", content: transcript });
    console.log(`[${new Date().toISOString()}] Updated conversation history (avant debounce):`, JSON.stringify(this.conversation, null, 2));
    this.conversation = this.conversation.slice(-CONVERSATION_HISTORY_LIMIT);
    if (this.inputDebounceTimer) clearTimeout(this.inputDebounceTimer);
    this.inputDebounceTimer = setTimeout(async () => {
      ttsAbort = false;
      await this.generateResponse();
    }, 800);
  }

  async generateResponse() {
    if (!this.active) return;
    speaking = true;
    ttsAbort = false;
    try {
      const stream = openai.beta.chat.completions.stream({
        model: "gpt-4o",
        temperature: 0.7,
        top_p: 0.85,
        frequency_penalty: 0.2,
        presence_penalty: 0.4,
        max_tokens: 200,
        messages: this.conversation,
        stream: true
      });
      let fullResponse = "";
      let partialBuffer = "";
      await this.sleep(300 + Math.random() * 400);
      for await (const chunk of stream) {
        if (!this.active || ttsAbort) break;
        const content = chunk.choices[0]?.delta?.content || "";
        fullResponse += content;
        partialBuffer += content;
        if (/[.!?]/.test(partialBuffer) && partialBuffer.length > 60) {
          const toSpeak = partialBuffer.trim();
          partialBuffer = "";
          await this.speakWithDelay(toSpeak, 150);
          if (ttsAbort) break;
        }
      }
      if (this.active && partialBuffer.trim() && !ttsAbort) {
        await this.speak(partialBuffer.trim());
      }
      if (fullResponse.trim() && !ttsAbort) {
        console.log(`[${new Date().toISOString()}] Assistant response generated: "${fullResponse.trim()}"`);
        // Conserver uniquement les derniers échanges pertinents
        if (this.conversation.length > 2) {
          this.conversation = this.conversation.slice(2);
        }
        this.conversation.push({ role: "assistant", content: fullResponse });
        console.log(`[${new Date().toISOString()}] Updated conversation history:`, JSON.stringify(this.conversation, null, 2));
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] GPT error:`, err);
      await this.speak("Je rencontre une difficulté technique, veuillez réessayer.");
    }
    speaking = false;
  }

  async speakWithDelay(text, delay = 300) {
    await this.sleep(delay);
    return this.speak(text);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

//------------------------------------------
// Démarrage du serveur
//------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!process.env.DEEPGRAM_API_KEY) console.error("DEEPGRAM_API_KEY manquant !");
});
