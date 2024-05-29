import './custom.css'
import React, { useState, useEffect } from 'react';
import { Container } from 'reactstrap';
import { io } from 'socket.io-client';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { getTokenOrRefresh } from './token_util';
import delay from 'delay';
import pTimeout from 'p-timeout';
import clsx from 'clsx';

var _player = undefined;
var _synthesizer = undefined;
var _conversationArr = [];
var _timefly = 0;
var _langtype = 'zh';

const _Lang = {
  en: ['en-US-AmberNeural', `Let's chat in English`, 'en-US'],
  zh: ['zh-CN-XiaoxiaoNeural', '我们一起聊天吧', 'zh-CN'],
}

var _displayTextArr = [
];

const _speechContext = {
  running: false,
  langArr: [],
}

const _socket = io();

_socket.on('connect', () => {
  console.log('connected');
});

async function genSpeechConfig() {
  const tokenObj = await getTokenOrRefresh();
  return speechsdk.SpeechConfig.fromAuthorizationToken(tokenObj.authToken, tokenObj.region);
}

function pushAndDisplayTextStr (line) {
  const max = 28;
  if (line) {
    _displayTextArr.push(line);
  }
  if (_displayTextArr.length > max) {
    _displayTextArr = _displayTextArr.slice(_displayTextArr.length - max);
  }
  return _displayTextArr.join('\n');
}

export default function App() {
  const [displayText, setDisplayText] = useState('👈 INITIALIZED: 👈 click the microphone button on the left to begin.');
  const [recognizer, setRecognizer] = useState(null);
  const [microphone, setMicrophone] = useState(false);
  const [virtualPartner, updateVirtualPartner] = useState('jpg');

  useEffect(() => {
    if (_socket.listeners('message')?.length > 0) {
      return;
    }

    setInterval(() => {
      if (Date.now() - _timefly >= 1000) {
        updateVirtualPartner('jpg');
      }
    }, 200);

    _socket.on('message', (eventData) => {
      console.log(eventData);
      const {
        sentence,
        conversationId,
        index,
        last,
      } = eventData;

      for (const it of _conversationArr) {
        if (conversationId === it.conversationId) {
          it.langArr.push({
            sentence,
            index,
            last,
          });
          it.langArr.sort((a, b) => {
            return a.index > b.index ? 1 : -1;
          });
          break;
        }
      }

      speech();
    });
  });

  function speech() {
    const willDelArr = [];

    for (const it of _conversationArr) {
      let lastItem = false;

      for (const item of it.langArr) {
        if (it.index === item.index) {
          _speechContext.langArr.push(item.sentence);
          if (item.last) {
            willDelArr.push(it.conversationId);
            lastItem = true;
            break;
          } else {
            ++it.index;
          }
        } else if (it.index < item.index) {
          break;
        }
      }

      if (!lastItem) {
        break;
      }
    }

    if (willDelArr.length > 0) {
      const temArr = [];
      for (const it of _conversationArr) {
        if (!willDelArr.includes(it.conversationId)) {
          temArr.push(it);
        }
      }
      _conversationArr = temArr;
    }

    langArrToSpeech();
  }

  async function langArrToSpeech() {
    if (_speechContext.running) {
      return;
    }

    _speechContext.running = true;

    for (;;) {
      if (_speechContext.langArr.length === 0) {
        break;
      }

      const sentence = _speechContext.langArr.shift();

      if (sentence) {
        if (!_synthesizer) {
          await delay(10);
        }
        try {
          await pTimeout(speakWithSsml(sentence), {
            milliseconds: 6000,
          });
        } catch (err) {
          console.error(err.message);
        }
      }
    }

    _speechContext.running = false;
  }

  function speakWithSsml(sentence) {
    setDisplayText(pushAndDisplayTextStr(sentence));

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="string">
      <voice name="${_Lang[_langtype][0]}">
        <mstts:express-as  style="friendly">
          <prosody rate="0%" pitch="0%">
          ${sentence}
          </prosody>
        </mstts:express-as>
      </voice>
    </speak>`;

    return new Promise((resolve, reject) => {
      if (!_synthesizer) {
        return reject({
          message: 'system busy',
        });
      }
      _synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          let text;
          if (result.reason === speechsdk.ResultReason.SynthesizingAudioCompleted) {
            text = `synthesis finished for "${sentence}".\n`;
          } else if (result.reason === speechsdk.ResultReason.Canceled) {
            text = `synthesis failed. Error detail: ${result.errorDetails}.\n`;
          }
          console.log(text);
          resolve();
        },
        (error) => {
          reject({ message: error });
        }
      );
    });
  }

  function audioStart () {
    _player.internalAudio.addEventListener('timeupdate', () => {
      _timefly = Date.now();
    });
    _timefly = Date.now();
    updateVirtualPartner('gif');
  }

  async function sttFromMic() {
    if (!microphone) {
      setMicrophone(true);
    }
    const speechConfig = await genSpeechConfig();
    if (!_player) {
      _player = new speechsdk.SpeakerAudioDestination();
      _player.onAudioStart = audioStart;
    }
    if (!_synthesizer) {
      const audioConfig = speechsdk.AudioConfig.fromSpeakerOutput(_player);
      _synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);
    }
    if (!recognizer) {
      const respond = await fetch('/api/get-lang');
      if (respond.ok) {
        _langtype = await respond.text();
      }

      speechConfig.speechRecognitionLanguage = _Lang[_langtype][2];
      const audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);
      setRecognizer(recognizer);
      setDisplayText('speak into your microphone...');
      await delay(100);
      recognizer.startContinuousRecognitionAsync(result => {
        console.log('result', result);
        _speechContext.langArr.push(_Lang[_langtype][1]);
        langArrToSpeech();
      }, err => {
        console.error('error', err);
      });

      recognizer.recognized = async (reco, e) => {
        try {
          const res = e.result;
          console.log(`recognized: ${res?.text}`);
          if (res?.text) {
            setDisplayText(pushAndDisplayTextStr(res?.text));
            for (const it of _conversationArr) {
              _socket.emit('abort', { conversationId: it.conversationId });
            }
            _conversationArr = [];
            _speechContext.langArr = [];

            const conversationId = `${Date.now()}`;
            _conversationArr.push({
              conversationId,
              index: 0,
              langArr: [],
            });
            _socket.emit('message', { message: res.text, conversationId });

            if (_synthesizer) {
              _synthesizer.close();
              _synthesizer = undefined;
            }

            if (_player) {
              const player = _player;
              _player = undefined;

              player.mute();
              player.pause();
              player.close(async () => {
                updateVirtualPartner('jpg');
                const speechConfig = await genSpeechConfig();
                _player = new speechsdk.SpeakerAudioDestination();
                _player.onAudioStart = audioStart;
                const audioConfig = speechsdk.AudioConfig.fromSpeakerOutput(_player);
                _synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);
              }, err => {
                console.error(err);
              });
            }
          }
        } catch (err) {
          console.error(err);
        }
      };
    }
  }

  return (
    <Container className="app-container">
      <div style={{marginTop: '20px'}}>
        <i className={clsx('fa fa-microphone fa-2x mr-2', {
          'red-microphone': !microphone,
          'blue-microphone': microphone,
        })} onClick={() => sttFromMic()}></i>
      </div>
      <div className="row main-container">
        <div className="col-6">
          <img className="virtual-partner-jpg" src={ virtualPartner === 'jpg' ? "/virtual_partner_0.jpg" : "/virtual_partner_0.gif" } alt="" />
        </div>
        <div className="col-6 output-display rounded">
          <code><pre>{displayText}</pre></code>
        </div>
      </div>
    </Container>
  );
}
