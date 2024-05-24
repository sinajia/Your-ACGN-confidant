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

export default function App() {
  const [displayText, setDisplayText] = useState('👈 INITIALIZED: 👈 click the microphone button on the left');
  const [recognizer, setRecognizer] = useState(null);
  const [microphone, setMicrophone] = useState(false);

  useEffect(() => {
    if (_socket.listeners('message')?.length > 0) {
      return;
    }

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
            milliseconds: 10000,
          });
        } catch (err) {
          console.error(err.message);
        }
      }
    }

    _speechContext.running = false;
  }

  function speakWithSsml(sentence) {
    setDisplayText(`speaking text: ${sentence}`);

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="string">
      <voice name="zh-CN-XiaoxiaoNeural">
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

  async function sttFromMic() {
    if (!microphone) {
      setMicrophone(true);
    }
    const speechConfig = await genSpeechConfig();
    if (!_player) {
      _player = new speechsdk.SpeakerAudioDestination();
    }
    if (!_synthesizer) {
      const audioConfig = speechsdk.AudioConfig.fromSpeakerOutput(_player);
      _synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);
    }
    if (!recognizer) {
      speechConfig.speechRecognitionLanguage = 'zh-CN'; // 'en-US';
      const audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);
      setRecognizer(recognizer);
      setDisplayText('speak into your microphone...');
      recognizer.startContinuousRecognitionAsync(result => {
          console.log('result', result);
      }, err => {
        console.error('error', err);
      });

      recognizer.recognized = async (reco, e) => {
        try {
            const res = e.result;
            console.log(`recognized: ${res?.text}`);
            setDisplayText(res?.text);
            if (res?.text) {
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

                player.pause();
                player.close(async () => {
                  const speechConfig = await genSpeechConfig();
                  _player = new speechsdk.SpeakerAudioDestination();
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
        <div className="row main-container">
            <div className="col-6">
                <i className={clsx('fa fa-microphone fa-2x mr-2', {
                  'red-microphone': !microphone,
                  'green-microphone': microphone,
                })} onClick={() => sttFromMic()}></i>
            </div>
            <div className="col-6 output-display rounded">
                <code>{displayText}</code>
            </div>
        </div>
    </Container>
  );
}
