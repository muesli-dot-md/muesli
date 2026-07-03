export interface TranscriptEvent {
  source: 'me' | 'them';
  text: string;
  t0: number;
  t1: number;
  utteranceId: number;
}

export interface TranscriptLine {
  text: string;
  final: boolean;
  utteranceId: number;
  t0: number;
}
