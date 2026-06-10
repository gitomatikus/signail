const getBrowserLocation = () => (typeof window !== 'undefined' ? window.location : null);

const stripTrailingColon = (protocol) => (protocol.endsWith(':') ? protocol.slice(0, -1) : protocol);

const buildUrl = (protocol, hostname, port, path = '') => {
  const normalizedProtocol = stripTrailingColon(protocol || 'http:');
  const normalizedPath = path
    ? path.startsWith('/') ? path : `/${path}`
    : '';
  const portSegment = port ? `:${port}` : '';
  return `${normalizedProtocol}://${hostname}${portSegment}${normalizedPath}`;
};

const location = getBrowserLocation();
const defaultHostname = process.env.REACT_APP_DEFAULT_HOST || location?.hostname || 'localhost';
const apiPort = process.env.REACT_APP_API_PORT || '8000';
const wsPort = process.env.REACT_APP_WS_PORT || apiPort;
const wsPath = process.env.REACT_APP_WS_PATH || '/ws';
const httpProtocol = location?.protocol || 'http:';
const wsProtocol = stripTrailingColon(httpProtocol) === 'https' ? 'wss:' : 'ws:';

const apiUrl =
  process.env.REACT_APP_API_URL ||
  buildUrl(httpProtocol, defaultHostname, apiPort, '');

const wsUrl =
  process.env.REACT_APP_WS_URL ||
  buildUrl(wsProtocol, defaultHostname, wsPort, wsPath);

const packEditorUrl =
  process.env.REACT_APP_PACK_EDITOR_URL || 'https://packer.critfail.art';

const config = {
  wsUrl,
  apiUrl,
  packEditorUrl
};

export default config; 
