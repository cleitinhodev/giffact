// Tipos centrais do documento

export interface Pt {
  x: number;
  y: number;
  /** multiplicador de espessura (pressão) — 1 = espessura cheia */
  p: number;
}

export type StrokeKind = 'curve' | 'line';

/**
 * Traço vetorial. Tratado como IMUTÁVEL: toda edição cria um novo objeto
 * (isso permite cache por identidade de objeto).
 */
export interface Stroke {
  id: string;
  kind: StrokeKind;
  pts: Pt[];
  closed: boolean;
  /** espessura base em pixels do documento */
  width: number;
  color: string;
  /** afinamento das pontas, fração do comprimento (0..0.5) */
  taperStart: number;
  taperEnd: number;
}

/** Ponto da máscara de recorte. c = 1 → canto (segmentos retos chegando/saindo). */
export interface CutPt { x: number; y: number; c?: number }

/** Máscara de recorte: área fechada cujo conteúdo (pixels do quadro do GIF) vira uma camada de imagem. */
export interface CutMask {
  pts: CutPt[];
  /** borda difusa em px do documento (0 = borda nítida, antisserrilhada) */
  feather: number;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  strokes: Stroke[];
  /** presente = camada de recorte (pixels do quadro dentro da máscara; não recebe traços) */
  cut?: CutMask;
}

export interface FrameDoc {
  layers: Layer[];
  activeLayer: number;
}

export interface GifFrame {
  canvas: HTMLCanvasElement;
  delay: number; // ms
}

export type ToolId =
  | 'select'
  | 'pen'
  | 'curve'
  | 'line'
  | 'edit'
  | 'weight'
  | 'pressure'
  | 'color'
  | 'eraser'
  | 'cutout'
  | 'hand';

export type EraserMode = 'stroke' | 'intersect' | 'area';
export type CutScope = 'current' | 'all' | 'range';

export interface Settings {
  width: number;
  color: string;
  stabilizer: number; // 0..20
  minPressure: number; // 0..1
  usePressure: boolean;
  taperStart: number;
  taperEnd: number;
  eraserMode: EraserMode;
  eraserSize: number;
  bgOpacity: number;
  bgGray: boolean;
  bgVisible: boolean;
  onion: boolean;
  onionPrev: number;
  onionNext: number;
  onionOpacity: number;
  onionPrevColor: string;
  onionNextColor: string;
  showPoints: boolean;
  scaleWidth: boolean;
  closeCurveSnap: boolean;
  swatches: string[];
  /** recorte: true = polígono (cantos retos); false = curva suave (Alt+clique faz canto) */
  cutPoly: boolean;
  cutFeather: number;
  cutScope: CutScope;
}

export const DEFAULT_SETTINGS: Settings = {
  width: 3,
  color: '#111111',
  stabilizer: 6,
  minPressure: 0.2,
  usePressure: true,
  taperStart: 0.12,
  taperEnd: 0.12,
  eraserMode: 'stroke',
  eraserSize: 12,
  bgOpacity: 0.6,
  bgGray: false,
  bgVisible: true,
  onion: false,
  onionPrev: 1,
  onionNext: 1,
  onionOpacity: 0.35,
  onionPrevColor: '#ff3b5c',
  onionNextColor: '#2f9bff',
  showPoints: true,
  scaleWidth: true,
  closeCurveSnap: true,
  cutPoly: false,
  cutFeather: 0,
  cutScope: 'current',
  swatches: ['#111111', '#444444', '#ffffff', '#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa'],
};
