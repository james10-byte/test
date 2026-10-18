export function createSseParser(onMessage) {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];
  let lastId;

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    onMessage({ event: eventName, data: dataLines.join('\n'), id: lastId });
    eventName = 'message';
    dataLines = [];
  };

  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
        else if (field === 'id') lastId = value;
      }
    }
  };
}
