import { describe, it, expect } from 'vitest';
import { httpBaseOf } from './httpBase';

describe('httpBaseOf', () => {
  it('maps ws://host/ws to http://host', () => {
    expect(httpBaseOf('ws://localhost:8787/ws')).toBe('http://localhost:8787');
  });

  it('maps wss://host/ws to https://host', () => {
    expect(httpBaseOf('wss://muesli.example.com/ws')).toBe('https://muesli.example.com');
  });

  it('leaves an http(s) base untouched', () => {
    expect(httpBaseOf('http://localhost:8787')).toBe('http://localhost:8787');
    expect(httpBaseOf('https://muesli.example.com')).toBe('https://muesli.example.com');
  });

  it('strips a trailing slash with no /ws suffix', () => {
    expect(httpBaseOf('ws://localhost:8787/')).toBe('http://localhost:8787');
  });
});
