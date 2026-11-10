/**
 * waveform.js
 * High-performance Canvas waveform renderer supporting:
 * - Color-coded annotations: ORANGE for Active, BLUE for Inactive
 * - Clear boundary indicators for all neighboring annotations
 * - Strict no-overlap constraints when dragging handles
 * - Full-file overview peaks + High-resolution dynamic window peaks
 * - Smooth zooming and panning across hours-long sessions
 * - Direct click on inactive annotations to switch active selection
 */

class WaveformViewer {
  constructor(canvasId, containerId, specCanvasId = null, specContainerId = null) {
    this.canvas = document.getElementById(canvasId);
    this.container = document.getElementById(containerId);
    this.ctx = this.canvas.getContext('2d');

    this.specCanvas = specCanvasId ? document.getElementById(specCanvasId) : null;
    this.specContainer = specContainerId ? document.getElementById(specContainerId) : null;
    this.specCtx = this.specCanvas ? this.specCanvas.getContext('2d') : null;
    this.specVisible = true;
    this.specColorScheme = 'magma';
    this.specImage = null;
    this.specRequestedKey = null;
    this.activeParticipant = null;

    this.globalPeaks = [];
    this.windowPeaks = [];
    this.windowStart = 0.0;
    this.windowEnd = 0.0;

    this.duration = 0.0;
    this.sampleRate = 16000;

    // View range in seconds
    this.viewStart = 0.0;
    this.viewEnd = 0.0;

    // Annotations list & active index
    this.allAnnotations = [];
    this.activeIndex = -1;

    // Active selection bounds in seconds
    this.selStart = 0.0;
    this.selEnd = 0.0;

    // Playhead in seconds
    this.playheadSec = 0.0;

    // Dragging state
    this.isDragging = false;
    this.dragTarget = null; // 'left', 'right', 'seek'

    // Callbacks
    this.onSelectionChange = null;
    this.onSelectAnnotation = null; // Click on inactive annotation
    this.onSeek = null;
    this.onRequestWindowPeaks = null;
    this.onViewChange = null; // (viewStart, viewEnd, duration)

    this._setupResize();
    this._setupMouseEvents();
  }

  _setupResize() {
    const resize = () => {
      const rect = this.container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.scale(dpr, dpr);
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;

      if (this.specCanvas && this.specContainer && this.specVisible) {
        const sRect = this.specContainer.getBoundingClientRect();
        this.specCanvas.width = sRect.width * dpr;
        this.specCanvas.height = sRect.height * dpr;
        if (this.specCtx) this.specCtx.scale(dpr, dpr);
        this.specCssWidth = sRect.width;
        this.specCssHeight = sRect.height;
        this.fetchSpectrogram();
      }

      this.render();
    };
    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
  }

  setGlobalData(peaks, duration, sampleRate = 16000) {
    this.globalPeaks = peaks || [];
    this.duration = duration || 0.0;
    this.sampleRate = sampleRate;
    this.viewStart = 0.0;
    this.viewEnd = this.duration;
    this.windowPeaks = [];
    this.specImage = null;
    this.specRequestedKey = null;
    this.fetchSpectrogram();
    this.render();
    if (this.onViewChange) {
      this.onViewChange(this.viewStart, this.viewEnd, this.duration);
    }
  }

  setWindowPeaks(peaks, startSec, endSec) {
    this.windowPeaks = peaks || [];
    this.windowStart = startSec;
    this.windowEnd = endSec;
    this.render();
  }

  setAnnotations(annotations, activeIndex, focus = true) {
    this.allAnnotations = annotations || [];
    this.activeIndex = activeIndex;

    const activeAnno = this.allAnnotations[activeIndex];
    if (activeAnno) {
      this.selStart = Math.max(0, activeAnno.start);
      this.selEnd = Math.max(this.selStart, activeAnno.end);

      if (focus && this.duration > 0) {
        const selDur = this.selEnd - this.selStart;
        const currentSpan = this.viewEnd - this.viewStart;

        let targetSpan;
        if (currentSpan > 0 && currentSpan < this.duration - 0.5) {
          // Preserve user's chosen zoom level across navigation
          targetSpan = Math.max(currentSpan, selDur + 0.6);
        } else {
          // Initial or reset default focus
          const margin = Math.max(1.2, selDur * 0.45);
          targetSpan = selDur + 2 * margin;
        }

        const annoCenter = (this.selStart + this.selEnd) / 2;
        let newStart = annoCenter - targetSpan / 2;
        let newEnd = annoCenter + targetSpan / 2;

        if (newStart < 0) {
          newEnd = Math.min(this.duration, newEnd - newStart);
          newStart = 0;
        }
        if (newEnd > this.duration) {
          newStart = Math.max(0, newStart - (newEnd - this.duration));
          newEnd = this.duration;
        }

        this.viewStart = Math.max(0, newStart);
        this.viewEnd = Math.min(this.duration, Math.max(this.viewStart + 0.5, newEnd));

        if (this.onRequestWindowPeaks) {
          this.onRequestWindowPeaks(this.viewStart, this.viewEnd);
        }
        this.fetchSpectrogram();
      }
    }
    this.render();
    if (this.onViewChange) {
      this.onViewChange(this.viewStart, this.viewEnd, this.duration);
    }
  }

  ensureTimeVisible(timeSec, marginRatio = 0.15) {
    if (this.duration <= 0) return;
    const span = this.viewEnd - this.viewStart;
    const margin = Math.max(0.1, span * marginRatio);
    if (timeSec < this.viewStart + margin) {
      const targetStart = Math.max(0, timeSec - margin);
      this.setView(targetStart, targetStart + span);
    } else if (timeSec > this.viewEnd - margin) {
      const targetEnd = Math.min(this.duration, timeSec + margin);
      const targetStart = Math.max(0, targetEnd - span);
      this.setView(targetStart, targetStart + span);
    }
  }

  setPlayhead(sec, autoFollow = false) {
    this.playheadSec = sec;
    if (autoFollow) {
      this.ensureTimeVisible(sec);
    } else {
      this.render();
    }
  }

  timeToX(timeSec) {
    const range = this.viewEnd - this.viewStart;
    if (range <= 0) return 0;
    return ((timeSec - this.viewStart) / range) * this.cssWidth;
  }

  xToTime(x) {
    const range = this.viewEnd - this.viewStart;
    if (this.cssWidth <= 0) return 0;
    return this.viewStart + (x / this.cssWidth) * range;
  }

  setView(startSec, endSec) {
    if (this.duration <= 0) return;
    const span = Math.min(this.duration, Math.max(0.5, endSec - startSec));
    this.viewStart = Math.max(0, Math.min(this.duration - span, startSec));
    this.viewEnd = Math.min(this.duration, this.viewStart + span);

    if (this.onRequestWindowPeaks) {
      this.onRequestWindowPeaks(this.viewStart, this.viewEnd);
    }
    this.fetchSpectrogram();
    this.render();
    if (this.onViewChange) {
      this.onViewChange(this.viewStart, this.viewEnd, this.duration);
    }
  }

  panLeft(ratio = 0.35) {
    const span = this.viewEnd - this.viewStart;
    const shift = span * ratio;
    this.setView(this.viewStart - shift, this.viewEnd - shift);
  }

  panRight(ratio = 0.35) {
    const span = this.viewEnd - this.viewStart;
    const shift = span * ratio;
    this.setView(this.viewStart + shift, this.viewEnd + shift);
  }

  panToFraction(frac) {
    if (this.duration <= 0) return;
    const span = this.viewEnd - this.viewStart;
    const maxStart = Math.max(0, this.duration - span);
    const targetStart = frac * maxStart;
    this.setView(targetStart, targetStart + span);
  }

  zoomIn() {
    if (this.duration <= 0) return;
    const center = (this.viewStart + this.viewEnd) / 2;
    const currentSpan = this.viewEnd - this.viewStart;
    const newSpan = Math.max(0.8, currentSpan * 0.65);
    this.setView(center - newSpan / 2, center + newSpan / 2);
  }

  zoomOut() {
    if (this.duration <= 0) return;
    const center = (this.viewStart + this.viewEnd) / 2;
    const currentSpan = this.viewEnd - this.viewStart;
    const newSpan = Math.min(this.duration, currentSpan * 1.5);
    this.setView(center - newSpan / 2, center + newSpan / 2);
  }

  resetZoom() {
    this.setView(0.0, this.duration);
  }

  render() {
    this.renderWaveform();
    this.renderSpectrogram();
  }

  fetchSpectrogram() {
    if (!this.specCanvas || !this.specVisible || !this.activeParticipant || this.duration <= 0) return;
    const start = Math.max(0, this.viewStart);
    const end = Math.min(this.duration, this.viewEnd);
    if (end <= start) return;

    const width = Math.max(200, Math.round(this.cssWidth || 800));
    const height = Math.max(40, Math.round(this.specCssHeight || 110));

    const key = `${this.activeParticipant}:${start.toFixed(2)}:${end.toFixed(2)}:${width}:${this.specColorScheme}`;
    if (this.specRequestedKey === key) return;
    this.specRequestedKey = key;

    const img = new Image();
    img.onload = () => {
      if (this.specRequestedKey === key) {
        this.specImage = img;
        this.specError = null;
        this.renderSpectrogram();
      }
    };
    img.onerror = () => {
      if (this.specRequestedKey === key) {
        this.specImage = null;
        this.specError = "Spectrogram unavailable (scipy/pillow missing). Please run run.bat";
        this.renderSpectrogram();
      }
    };
    img.src = `/api/spectrogram?participant=${encodeURIComponent(this.activeParticipant)}&start=${start.toFixed(3)}&end=${end.toFixed(3)}&width=${width}&height=${height}&color_scheme=${encodeURIComponent(this.specColorScheme)}`;
  }

  setSpectrogramVisible(visible) {
    this.specVisible = !!visible;
    if (this.specContainer) {
      this.specContainer.classList.toggle('hidden', !this.specVisible);
    }
    setTimeout(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.container.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.scale(dpr, dpr);
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;

      if (this.specCanvas && this.specContainer && this.specVisible) {
        const sRect = this.specContainer.getBoundingClientRect();
        this.specCanvas.width = sRect.width * dpr;
        this.specCanvas.height = sRect.height * dpr;
        if (this.specCtx) this.specCtx.scale(dpr, dpr);
        this.specCssWidth = sRect.width;
        this.specCssHeight = sRect.height;
        this.fetchSpectrogram();
      }
      this.render();
    }, 40);
  }

  setSpectrogramColorScheme(scheme) {
    this.specColorScheme = (scheme === 'bw' || scheme === 'grayscale') ? 'bw' : 'magma';
    if (this.specContainer) {
      this.specContainer.classList.toggle('spectrogram-bw', this.specColorScheme === 'bw');
    }
    this.specRequestedKey = null;
    this.fetchSpectrogram();
  }

  renderSpectrogram() {
    if (!this.specCtx || !this.specVisible || !this.specCssWidth || !this.specCssHeight) return;
    const width = this.specCssWidth;
    const height = this.specCssHeight;
    const isBw = this.specColorScheme === 'bw';

    this.specCtx.clearRect(0, 0, width, height);

    // 1. Background (White for B&W, dark for Voice Magma)
    this.specCtx.fillStyle = isBw ? '#ffffff' : '#0a0f1d';
    this.specCtx.fillRect(0, 0, width, height);

    // 2. Spectrogram image
    if (this.specImage) {
      this.specCtx.drawImage(this.specImage, 0, 0, width, height);
    } else if (this.specError) {
      this.specCtx.fillStyle = '#f59e0b';
      this.specCtx.font = '12px system-ui, sans-serif';
      this.specCtx.fillText('⚠️ ' + this.specError, Math.max(16, (width - 440) / 2), height / 2 + 4);
    } else {
      this.specCtx.fillStyle = isBw ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.3)';
      this.specCtx.font = '11px ui-monospace, monospace';
      this.specCtx.fillText('Loading spectrogram...', width / 2 - 60, height / 2);
    }

    // 3. Horizontal Frequency Grid lines
    this.specCtx.strokeStyle = isBw ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)';
    this.specCtx.lineWidth = 1;
    this.specCtx.setLineDash([3, 4]);

    [0.5, 0.75, 0.875].forEach((ratio) => {
      const y = Math.round(height * ratio);
      this.specCtx.beginPath();
      this.specCtx.moveTo(0, y);
      this.specCtx.lineTo(width, y);
      this.specCtx.stroke();
    });
    this.specCtx.setLineDash([]);

    // 4. Overlays for Inactive Annotations
    if (this.allAnnotations && this.allAnnotations.length > 0) {
      this.allAnnotations.forEach((anno, i) => {
        if (i === this.activeIndex) return;
        if (anno.end < this.viewStart || anno.start > this.viewEnd) return;

        const x1 = Math.max(0, this.timeToX(anno.start));
        const x2 = Math.min(width, this.timeToX(anno.end));
        const bw = Math.max(2, x2 - x1);

        this.specCtx.fillStyle = 'rgba(2, 132, 199, 0.18)';
        this.specCtx.fillRect(x1, 0, bw, height);

        this.specCtx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
        this.specCtx.lineWidth = 1;
        this.specCtx.beginPath();
        this.specCtx.moveTo(x1, 0);
        this.specCtx.lineTo(x1, height);
        this.specCtx.moveTo(x2, 0);
        this.specCtx.lineTo(x2, height);
        this.specCtx.stroke();
      });
    }

    // 5. Active Annotation Selection
    if (this.selEnd > this.selStart) {
      const selX1 = this.timeToX(this.selStart);
      const selX2 = this.timeToX(this.selEnd);
      const selW = Math.max(2, selX2 - selX1);

      this.specCtx.fillStyle = 'rgba(245, 158, 11, 0.18)';
      this.specCtx.fillRect(selX1, 0, selW, height);

      this.specCtx.strokeStyle = '#f59e0b';
      this.specCtx.lineWidth = 2;
      this.specCtx.beginPath();
      this.specCtx.moveTo(selX1, 0);
      this.specCtx.lineTo(selX1, height);
      this.specCtx.moveTo(selX2, 0);
      this.specCtx.lineTo(selX2, height);
      this.specCtx.stroke();
    }

    // 6. Playhead cursor on spectrogram
    if (this.playheadSec >= this.viewStart && this.playheadSec <= this.viewEnd) {
      const playheadX = this.timeToX(this.playheadSec);
      this.specCtx.strokeStyle = '#f43f5e';
      this.specCtx.lineWidth = 2;
      this.specCtx.beginPath();
      this.specCtx.moveTo(playheadX, 0);
      this.specCtx.lineTo(playheadX, height);
      this.specCtx.stroke();
    }
  }

  renderWaveform() {
    if (!this.ctx || !this.cssWidth || !this.cssHeight) return;
    const width = this.cssWidth;
    const height = this.cssHeight;
    const midY = height / 2;

    this.ctx.clearRect(0, 0, width, height);

    // 1. Background grid
    this.ctx.fillStyle = '#0a0f1d';
    this.ctx.fillRect(0, 0, width, height);

    const viewSpan = this.viewEnd - this.viewStart;
    if (viewSpan <= 0) return;

    // Time markings
    let stepSec = 1.0;
    if (viewSpan > 300) stepSec = 60.0;
    else if (viewSpan > 120) stepSec = 30.0;
    else if (viewSpan > 30) stepSec = 5.0;
    else if (viewSpan > 8) stepSec = 1.0;
    else if (viewSpan > 2) stepSec = 0.5;
    else stepSec = 0.1;

    this.ctx.strokeStyle = '#1e293b';
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '10px ui-monospace, monospace';

    const firstMark = Math.floor(this.viewStart / stepSec) * stepSec;
    for (let t = firstMark; t <= this.viewEnd; t += stepSec) {
      if (t < this.viewStart) continue;
      const x = this.timeToX(t);
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();

      const mins = Math.floor(t / 60);
      const secs = (t % 60).toFixed(stepSec < 1 ? 1 : 0);
      const label = `${mins}:${secs.padStart(stepSec < 1 ? 4 : 2, '0')}`;
      this.ctx.fillText(label, x + 4, 12);
    }

    // Center baseline
    this.ctx.strokeStyle = '#1f2d42';
    this.ctx.beginPath();
    this.ctx.moveTo(0, midY);
    this.ctx.lineTo(width, midY);
    this.ctx.stroke();

    // 2. Waveform Rendering
    const hasValidWindow = this.windowPeaks && this.windowPeaks.length > 0 &&
      this.windowStart <= this.viewStart + 0.5 && this.windowEnd >= this.viewEnd - 0.5;

    let peaksToRender = [];
    let pStart = 0.0;
    let pSpan = this.duration;

    if (hasValidWindow) {
      peaksToRender = this.windowPeaks;
      pStart = this.windowStart;
      pSpan = this.windowEnd - this.windowStart;
    } else if (this.globalPeaks && this.globalPeaks.length > 0) {
      peaksToRender = this.globalPeaks;
      pStart = 0.0;
      pSpan = this.duration;
    }

    if (peaksToRender.length > 0 && pSpan > 0) {
      const numPairs = peaksToRender.length / 2;
      const pairDuration = pSpan / numPairs;

      const firstVisiblePair = Math.max(0, Math.floor((this.viewStart - pStart) / pairDuration));
      const lastVisiblePair = Math.min(numPairs, Math.ceil((this.viewEnd - pStart) / pairDuration));

      this.ctx.strokeStyle = '#7dd3fc'; // Soft sky blue for sound wave
      this.ctx.lineWidth = 1.5;

      for (let i = firstVisiblePair; i < lastVisiblePair; i++) {
        const t = pStart + (i * pairDuration);
        const x = this.timeToX(t);
        const minVal = peaksToRender[i * 2];
        const maxVal = peaksToRender[i * 2 + 1];

        const amp = 1.25;
        const yTop = midY - (Math.min(1.0, maxVal * amp) * midY * 0.92);
        const yBottom = midY - (Math.max(-1.0, minVal * amp) * midY * 0.92);
        const barHeight = Math.max(2.0, yBottom - yTop);

        this.ctx.beginPath();
        this.ctx.moveTo(x, yTop);
        this.ctx.lineTo(x, yTop + barHeight);
        this.ctx.stroke();
      }
    }

    // 3. Render Inactive Annotations in BLUE
    if (this.allAnnotations && this.allAnnotations.length > 0) {
      this.allAnnotations.forEach((anno, idx) => {
        if (idx === this.activeIndex) return; // Rendered separately in Orange
        if (anno.end < this.viewStart || anno.start > this.viewEnd) return; // Out of view

        const ax1 = this.timeToX(anno.start);
        const ax2 = this.timeToX(anno.end);
        const aw = Math.max(2, ax2 - ax1);

        // Blue fill for inactive annotations
        this.ctx.fillStyle = 'rgba(14, 116, 144, 0.22)';
        this.ctx.fillRect(ax1, 0, aw, height);

        // Blue boundary lines
        this.ctx.strokeStyle = '#0284c7';
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(ax1, 0);
        this.ctx.lineTo(ax1, height);
        this.ctx.moveTo(ax2, 0);
        this.ctx.lineTo(ax2, height);
        this.ctx.stroke();

        // Inactive annotation label badge
        this.ctx.fillStyle = '#38bdf8';
        this.ctx.font = '10px ui-monospace, monospace';
        this.ctx.fillText(`#${idx + 1}`, ax1 + 4, height - 6);
      });
    }

    // 4. Render Active Annotation in ORANGE / AMBER
    if (this.selEnd > this.selStart) {
      const selX1 = this.timeToX(this.selStart);
      const selX2 = this.timeToX(this.selEnd);
      const selW = Math.max(4, selX2 - selX1);

      // Warm Amber / Orange fill for active annotation
      this.ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
      this.ctx.fillRect(selX1, 0, selW, height);

      // Prominent clean Orange boundaries
      this.ctx.strokeStyle = '#f59e0b';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(selX1, 0);
      this.ctx.lineTo(selX1, height);
      this.ctx.moveTo(selX2, 0);
      this.ctx.lineTo(selX2, height);
      this.ctx.stroke();

      // Top badge for active annotation
      this.ctx.fillStyle = '#f59e0b';
      this.ctx.font = 'bold 10px ui-monospace, monospace';
      const labelText = `#${this.activeIndex + 1} (Active)`;
      this.ctx.fillText(labelText, selX1 + 4, 18);

      // Compact Top & Bottom Boundary Tabs (leaves middle waveform completely unobstructed)
      const tabW = 6;
      const tabH = 8;
      this.ctx.fillStyle = '#d97706';
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1;

      // Left boundary markers (top and bottom edges)
      this.ctx.fillRect(selX1 - tabW / 2, 0, tabW, tabH);
      this.ctx.strokeRect(selX1 - tabW / 2, 0, tabW, tabH);
      this.ctx.fillRect(selX1 - tabW / 2, height - tabH, tabW, tabH);
      this.ctx.strokeRect(selX1 - tabW / 2, height - tabH, tabW, tabH);

      // Right boundary markers (top and bottom edges)
      this.ctx.fillRect(selX2 - tabW / 2, 0, tabW, tabH);
      this.ctx.strokeRect(selX2 - tabW / 2, 0, tabW, tabH);
      this.ctx.fillRect(selX2 - tabW / 2, height - tabH, tabW, tabH);
      this.ctx.strokeRect(selX2 - tabW / 2, height - tabH, tabW, tabH);
    }

    // 5. Playhead
    if (this.playheadSec >= this.viewStart && this.playheadSec <= this.viewEnd) {
      const playheadX = this.timeToX(this.playheadSec);
      this.ctx.strokeStyle = '#f43f5e';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(playheadX, 0);
      this.ctx.lineTo(playheadX, height);
      this.ctx.stroke();

      this.ctx.fillStyle = '#f43f5e';
      this.ctx.beginPath();
      this.ctx.moveTo(playheadX - 6, 0);
      this.ctx.lineTo(playheadX + 6, 0);
      this.ctx.lineTo(playheadX, 9);
      this.ctx.fill();
    }
  }

  _setupMouseEvents() {
    const bindCanvasEvents = (canvasEl) => {
      if (!canvasEl) return;
      const getX = (e) => {
        const rect = canvasEl.getBoundingClientRect();
        return e.clientX - rect.left;
      };

      canvasEl.addEventListener('mousedown', (e) => {
        const x = getX(e);
        const time = this.xToTime(x);

        const selX1 = this.timeToX(this.selStart);
        const selX2 = this.timeToX(this.selEnd);

        // Handle proximity check (within 10px)
        if (Math.abs(x - selX1) <= 10) {
          this.isDragging = true;
          this.dragTarget = 'left';
        } else if (Math.abs(x - selX2) <= 10) {
          this.isDragging = true;
          this.dragTarget = 'right';
        } else {
          // Check if user clicked inside an inactive annotation to select it
          let clickedInactiveIdx = -1;
          if (this.allAnnotations) {
            for (let i = 0; i < this.allAnnotations.length; i++) {
              if (i === this.activeIndex) continue;
              const a = this.allAnnotations[i];
              if (time >= a.start && time <= a.end) {
                clickedInactiveIdx = i;
                break;
              }
            }
          }

          if (clickedInactiveIdx >= 0) {
            if (this.onSelectAnnotation) {
              this.onSelectAnnotation(clickedInactiveIdx);
            }
          } else {
            // Normal seek
            this.isDragging = true;
            this.dragTarget = 'seek';
            if (this.onSeek) this.onSeek(time);
          }
        }
      });

      canvasEl.addEventListener('mousemove', (e) => {
        if (this.isDragging) return;
        const x = getX(e);
        const selX1 = this.timeToX(this.selStart);
        const selX2 = this.timeToX(this.selEnd);

        if (Math.abs(x - selX1) <= 8 || Math.abs(x - selX2) <= 8) {
          canvasEl.style.cursor = 'ew-resize';
        } else {
          canvasEl.style.cursor = 'crosshair';
        }
      });

      canvasEl.addEventListener('wheel', (e) => {
        if (this.duration <= 0) return;
        e.preventDefault();
        if (e.ctrlKey) {
          // Zoom centered at mouse position
          const mouseSec = this.xToTime(getX(e));
          const factor = e.deltaY < 0 ? 0.75 : 1.35;
          const currentSpan = this.viewEnd - this.viewStart;
          const newSpan = Math.min(this.duration, Math.max(0.6, currentSpan * factor));
          const frac = (mouseSec - this.viewStart) / (currentSpan || 1);
          this.setView(mouseSec - frac * newSpan, mouseSec + (1 - frac) * newSpan);
        } else {
          // Pan horizontally
          const delta = Math.abs(e.deltaX) > 0 ? e.deltaX : e.deltaY;
          const shiftSec = (delta / (this.cssWidth || 800)) * (this.viewEnd - this.viewStart) * 0.8;
          this.setView(this.viewStart + shiftSec, this.viewEnd + shiftSec);
        }
      }, { passive: false });
    };

    bindCanvasEvents(this.canvas);
    if (this.specCanvas) bindCanvasEvents(this.specCanvas);

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = Math.max(0, Math.min(this.duration, this.xToTime(x)));

      // Strict No-Overlap Constraints when dragging
      const prevAnno = (this.activeIndex > 0 && this.allAnnotations) ? this.allAnnotations[this.activeIndex - 1] : null;
      const nextAnno = (this.activeIndex >= 0 && this.allAnnotations && this.activeIndex < this.allAnnotations.length - 1)
        ? this.allAnnotations[this.activeIndex + 1] : null;

      const minAllowedStart = prevAnno ? (prevAnno.end + 0.005) : 0.0;
      const maxAllowedEnd = nextAnno ? (nextAnno.start - 0.005) : this.duration;

      if (this.dragTarget === 'left') {
        const clampedStart = Math.max(minAllowedStart, Math.min(time, this.selEnd - 0.05));
        this.selStart = clampedStart;
        this.render();
        if (this.onSelectionChange) this.onSelectionChange(this.selStart, this.selEnd);
      } else if (this.dragTarget === 'right') {
        const clampedEnd = Math.min(maxAllowedEnd, Math.max(time, this.selStart + 0.05));
        this.selEnd = clampedEnd;
        this.render();
        if (this.onSelectionChange) this.onSelectionChange(this.selStart, this.selEnd);
      } else if (this.dragTarget === 'seek') {
        if (this.onSeek) this.onSeek(time);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.dragTarget = null;
    });
  }
}
