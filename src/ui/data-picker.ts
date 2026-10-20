// Pantalla para elegir los datos del juego cuando no hay servidor que los sirva (GitHub Pages).
// No puede usar nada del juego (aún no hay datos), así que se dibuja con texto del navegador.
import {
  buildFileMap,
  entriesFromDrop,
  entriesFromFileList,
  entriesFromZip,
  type FileEntry,
} from '../data/local';
import type { LocalFile } from '../data/vfs';

interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  run: () => void;
}

export class DataPicker {
  readonly done: Promise<Map<string, LocalFile>>;
  private resolve!: (files: Map<string, LocalFile>) => void;
  private buttons: Button[];
  private hover: Button | null = null;
  private status = '';
  private error = '';
  private busy = false;
  private dragging = false;
  private folderInput = document.createElement('input');
  private zipInput = document.createElement('input');

  constructor(private ctx: CanvasRenderingContext2D, private canvas: HTMLCanvasElement) {
    this.done = new Promise((ok) => (this.resolve = ok));
    this.folderInput.type = 'file';
    this.folderInput.webkitdirectory = true;
    this.folderInput.multiple = true;
    this.zipInput.type = 'file';
    this.zipInput.accept = '.zip,application/zip';
    for (const input of [this.folderInput, this.zipInput]) {
      input.hidden = true;
      document.body.append(input);
    }
    this.folderInput.addEventListener('change', () => {
      if (this.folderInput.files?.length) void this.load(async () => entriesFromFileList(this.folderInput.files!));
      this.folderInput.value = '';
    });
    this.zipInput.addEventListener('change', () => {
      const f = this.zipInput.files?.[0];
      if (f) void this.load(() => entriesFromZip(f));
      this.zipInput.value = '';
    });
    this.buttons = [
      { x: 150, y: 300, w: 160, h: 30, label: 'Elegir carpeta', run: () => this.folderInput.click() },
      { x: 330, y: 300, w: 160, h: 30, label: 'Elegir ZIP', run: () => this.zipInput.click() },
    ];
    window.addEventListener('dragover', this.onDragOver);
    window.addEventListener('dragleave', this.onDragLeave);
    window.addEventListener('drop', this.onDrop);
    this.canvas.style.cursor = 'default';
    this.draw();
  }

  private onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (!this.dragging) {
      this.dragging = true;
      this.draw();
    }
  };

  private onDragLeave = (): void => {
    this.dragging = false;
    this.draw();
  };

  private onDrop = (e: DragEvent): void => {
    e.preventDefault();
    this.dragging = false;
    if (e.dataTransfer) {
      const dt = e.dataTransfer;
      // los items de un DataTransfer sólo valen durante el evento: se leen ya
      const pending = entriesFromDrop(dt);
      void this.load(() => pending);
    }
  };

  private async load(read: () => Promise<FileEntry[]>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.status = 'Leyendo ficheros...';
    this.draw();
    try {
      const { files, missing } = buildFileMap(await read());
      if (missing.length) {
        this.error = files.size
          ? `Faltan ficheros del juego: ${missing.join(', ')}`
          : 'No es una instalación de Dark Colony: falta GAMESTAT/GAMESTAT.TXT';
        return;
      }
      this.status = `${files.size} ficheros listos`;
      this.close();
      this.resolve(files);
    } catch (err) {
      console.error(err);
      this.error = 'No se pudieron leer los ficheros (¿ZIP dañado?)';
    } finally {
      this.busy = false;
      this.draw();
    }
  }

  private close(): void {
    window.removeEventListener('dragover', this.onDragOver);
    window.removeEventListener('dragleave', this.onDragLeave);
    window.removeEventListener('drop', this.onDrop);
    this.folderInput.remove();
    this.zipInput.remove();
    this.canvas.style.cursor = '';
  }

  private at(x: number, y: number): Button | null {
    return this.buttons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) ?? null;
  }

  mouseMove(x: number, y: number): void {
    const h = this.busy ? null : this.at(x, y);
    if (h !== this.hover) {
      this.hover = h;
      this.canvas.style.cursor = h ? 'pointer' : 'default';
      this.draw();
    }
  }

  mouseDown(x: number, y: number, b: number): void {
    if (b !== 0 || this.busy) return;
    this.at(x, y)?.run();
  }

  draw(): void {
    const c = this.ctx;
    c.fillStyle = '#000';
    c.fillRect(0, 0, 640, 480);
    c.strokeStyle = this.dragging ? '#4cc59c' : '#1d3b33';
    c.lineWidth = 2;
    c.setLineDash(this.dragging ? [] : [6, 4]);
    c.strokeRect(40, 60, 560, 340);
    c.setLineDash([]);
    c.textAlign = 'center';
    c.fillStyle = '#5ff';
    c.font = 'bold 28px monospace';
    c.fillText('OPEN DARK COLONY', 320, 120);
    c.fillStyle = '#ccc';
    c.font = '14px monospace';
    const lines = [
      'Este clon usa los ficheros de tu copia de Dark Colony.',
      'Elige la carpeta del juego (la que contiene GAMESTAT,',
      'SPRITES, SCENARIO...) o un ZIP con ella, o suéltala aquí.',
    ];
    lines.forEach((l, i) => c.fillText(l, 320, 175 + i * 22));
    c.fillStyle = '#8a8';
    c.font = '12px monospace';
    c.fillText('Se leen en tu navegador y no se suben a ningún sitio.', 320, 260);
    for (const b of this.buttons) {
      const on = b === this.hover;
      c.fillStyle = on ? '#4cc59c' : '#14332b';
      c.fillRect(b.x, b.y, b.w, b.h);
      c.fillStyle = on ? '#000' : '#cfe';
      c.font = 'bold 14px monospace';
      c.fillText(b.label, b.x + b.w / 2, b.y + 20);
    }
    c.font = '13px monospace';
    if (this.error) {
      c.fillStyle = '#f66';
      c.fillText(this.error, 320, 365);
    } else if (this.status) {
      c.fillStyle = '#ff8';
      c.fillText(this.status, 320, 365);
    }
    c.fillStyle = '#666';
    c.font = '11px monospace';
    c.fillText('Se guardan en este navegador para la próxima vez.', 320, 455);
  }
}
