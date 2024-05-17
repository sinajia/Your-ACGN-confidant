require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const pino = require('pino-http')();
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const { format } = require('date-fns');

const { ChatAlibabaTongyi } = require("@langchain/community/chat_models/alibaba_tongyi");
const { StringOutputParser } = require("@langchain/core/output_parsers");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const { RunnableSequence } = require("@langchain/core/runnables");
const { CheerioWebBaseLoader } = require("@langchain/community/document_loaders/web/cheerio");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const {
  SpeechConfig,
  SpeechSynthesizer,
  ResultReason,
  ProfanityOption,
} = require("microsoft-cognitiveservices-speech-sdk");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(pino);

const chatModel = new ChatAlibabaTongyi({
  modelName: 'qwen-max',
  temperature: 0.9,
  alibabaApiKey: process.env.ALIBABA_API_KEY,
});

const controllerMap = new Map();

app.get('/api/get-speech-token', async (req, res) => {
  const speechKey = process.env.SPEECH_KEY;
  const speechRegion = process.env.SPEECH_REGION;

  if (!(speechKey && speechRegion)) {
      res.status(400).send('You forgot to add your speech key or region to the .env file.');
  } else {
    const headers = {
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    try {
      const tokenResponse = await axios.post(`https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, null, headers);
      res.json({ token: tokenResponse.data, region: speechRegion });
    } catch (err) {
      res.status(401).send('There was an error authorizing your speech key.');
    }
  }
});

const server = require('http').createServer(app);

const io = require('socket.io')(server);

io.on('connection', client => {
  client.on('message', async (data) => {
    const { message: question, conversationId } = data;

    const symbols = [
      '，',
      '。',
      ',',
      '.',
      ':',
      '：',
      '?',
      '？',
      '!',
      '！',
      ';',
      '；',
    ];

    const controller = new AbortController();

    controllerMap.set(conversationId, controller);

    const model = chatModel.bind({ signal: controller.signal });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "你的角色是“私人助理”，你擅长与小朋友交流，你博学多才、幽默风趣。"],
      ["user", "{question}"],
    ]);

    const retrievalChain = RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);

    var index = 0;
    var textArr = [];
    const answer = [];

    try {
      const streamAnswer = await retrievalChain.stream({
        question: question.substring(0, 4096),
      });

      for await (const chunk of streamAnswer) {
        answer.push(chunk);
        const pos = markPosition(chunk, symbols);
        if (pos === -1) {
          textArr.push(chunk);
        } else {
          const sentence = textArr.join('');
          if (sentence.length + chunk.substring(0, pos).length < 12) {
            textArr.push(chunk);
          } else {
            textArr = [
              chunk.substring(pos + 1),
            ];
            wsChatFragment({
              client,
              sentence: sentence + chunk.substring(0, pos + 1),
              conversationId,
              index: index++,
            });
          }
        }
      }
    } catch (e) {
      answer.push(e.message) || console.error(e.message);
    }

    controllerMap.delete(conversationId);

    wsChatFragment({
      client,
      sentence: textArr.join(''),
      conversationId,
      index: index++,
      last: true,
    });

    appendFileSync(path.join(__dirname, '..', 'history-info.log'), JSON.stringify({
      question,
      answer: answer.join(''),
      timestamp: format(new Date(), 'yy-MM-dd H:m:s'),
    }, null, ' ') + '\n', 'utf-8');
  }); // end client.on('message'

  client.on('disconnect', () => { /* … */ });

  client.on('abort', (data) => {
    const { conversationId } = data;
    if (controllerMap.has(conversationId)) {
      controllerMap.get(conversationId).abort();
      controllerMap.delete(conversationId);
    }
  });
}); // end io.on('connection'

function markPosition (str, symbols) {
  for (const it of symbols) {
    const pos = str.indexOf(it);
    if (!(pos === -1)) {
      return pos;
    }
  }
  return -1;
}

function wsChatFragment({
  client,
  sentence,
  conversationId,
  index,
  last,
}) {
  client.emit('message', {
    sentence,
    conversationId,
    index,
    last,
  });
}

server.listen(4321, () =>
  console.log(`Express server is running on localhost:${4321}`)
);
