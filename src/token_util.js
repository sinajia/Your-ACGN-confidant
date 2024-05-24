import axios from 'axios';
import Cookie from 'universal-cookie';

export async function getTokenOrRefresh() {
  const cookie = new Cookie();
  const speechToken = cookie.get('speech-token');

  if (!speechToken) {
    try {
      const res = await axios.get('/api/get-speech-token');
      const { token, region } = res.data;

      cookie.set('speech-token', region + ':' + token, {maxAge: 540, path: '/'});

      console.log('Token fetched from back-end: ' + token);

      return { authToken: token, region };
    } catch (err) {
      console.error(err.response.data);
      return { authToken: null, error: err.response.data };
    }
  } else {
    console.log('Token fetched from cookie: ' + speechToken);
    const idx = speechToken.indexOf(':');
    return { authToken: speechToken.slice(idx + 1), region: speechToken.slice(0, idx) };
  }
}
