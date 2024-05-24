require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const pino = require('pino-http')();
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const { format } = require('date-fns');
const colors = require('@colors/colors/safe');

const { ChatOpenAI } = require("@langchain/openai");
const { ChatAlibabaTongyi } = require("@langchain/community/chat_models/alibaba_tongyi");
const { StringOutputParser } = require("@langchain/core/output_parsers");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const { RunnableSequence } = require("@langchain/core/runnables");
const { CheerioWebBaseLoader } = require("@langchain/community/document_loaders/web/cheerio");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(pino);

const controllerMap = new Map();

if (process.env.OPENAI_API_KEY) {
 var chatModel = new ChatOpenAI({
    temperature: 0.9,
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log(colors.green('Openai available'));
} else if (process.env.ALIBABA_API_KEY) {
  chatModel = new ChatAlibabaTongyi({
    modelName: 'qwen-max',
    temperature: 0.9,
    alibabaApiKey: process.env.ALIBABA_API_KEY,
  });
  console.log(colors.green('Tongyi available'));
} else {
  console.error(colors.red('None available LLM'));
}

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

    var index = 0;
    const fullReply = [];

    if (chatModel) {
      const controller = new AbortController();

      controllerMap.set(conversationId, controller);

      const model = chatModel.bind({ signal: controller.signal });

      const prompt = ChatPromptTemplate.fromMessages([
        ["system", 'You are a "personal assistant" and you are good at chatting with children and the elderly. You are knowledgeable, humorous, and can write poetry. The text you type will be immediately available for voice playback.'],
        ["user", "{question}"],
      ]);

      const retrievalChain = RunnableSequence.from([
        prompt,
        model,
        new StringOutputParser(),
      ]);

      var textArr = [];

      try {
        const streamAnswer = await retrievalChain.stream({
          question: question.substring(0, 4096),
        });

        for await (const chunk of streamAnswer) {
          fullReply.push(chunk);
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
        fullReply.push(e.message ?? '') || console.error(e.message);
      }

      controllerMap.delete(conversationId);

      wsChatFragment({
        client,
        sentence: textArr.join(''),
        conversationId,
        index: index++,
        last: true,
      });
    } else {
      const sentence = 'None available LLM';
      wsChatFragment({
        client,
        sentence,
        conversationId,
        index,
        last: true,
      });
      fullReply.push(sentence);
    }

    appendFileSync(path.join(__dirname, '..', 'history-info.log'), JSON.stringify({
      question,
      answer: fullReply.join(''),
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
