/**
 * app.js
 * Core application controller:
 * - Color-coded annotations on waveform: Orange for Active, Blue for Inactive
 * - Strict No-Overlap constraint across all operations (snap, split, drag, edit)
 * - Automatic session state persistence (reopens exact participant & utterance on reload)
 * - Regular periodic autosaves to .autosave/ and timestamped backups in .backups/
 * - Customizable shortcuts engine persisted in localStorage
 * - Undo / Redo history engine
 * - Explicit Save Active, Save All, and Save As options
 */

const DEFAULT_SHORTCUTS = {
  playPause: { key: 'Tab', ctrl: false, alt: false, shift: false, label: 'Tab' },
  next: { key: 'PageDown', ctrl: false, alt: false, shift: false, label: 'PageDown' },
  prev: { key: 'PageUp', ctrl: false, alt: false, shift: false, label: 'PageUp' },
  snap: { key: 'q', ctrl: false, alt: true, shift: false, label: 'Alt+Q' },
  snapTrim: { key: 'w', ctrl: false, alt: true, shift: false, label: 'Alt+W' },
  addUtterance: { key: 'a', ctrl: false, alt: true, shift: false, label: 'Alt+A' },
  transcribe: { key: 't', ctrl: false, alt: true, shift: false, label: 'Alt+T' },
  grammar: { key: 'g', ctrl: false, alt: true, shift: false, label: 'Alt+G' },
  split: { key: 's', ctrl: false, alt: true, shift: false, label: 'Alt+S' },
  mergeNext: { key: 'm', ctrl: false, alt: true, shift: false, label: 'Alt+M' },
  seekForward: { key: 'ArrowRight', ctrl: false, alt: false, shift: true, label: 'Shift+Right' },
  seekBackward: { key: 'ArrowLeft', ctrl: false, alt: false, shift: true, label: 'Shift+Left' },
  delete: { key: 'Delete', ctrl: false, alt: true, shift: false, label: 'Alt+Delete' },
  audioMode: { key: 'm', ctrl: false, alt: false, shift: false, label: 'M' },
  undo: { key: 'z', ctrl: true, alt: false, shift: false, label: 'Ctrl+Z' },
  redo: { key: 'y', ctrl: true, alt: false, shift: false, label: 'Ctrl+Y' },

  tagBackchannel: { key: 'b', ctrl: false, alt: true, shift: false, label: 'Alt+B' },
  tagLaugh: { key: 'l', ctrl: false, alt: true, shift: false, label: 'Alt+L' },
  tagNoise: { key: 'n', ctrl: false, alt: true, shift: false, label: 'Alt+N' },
  tagWordDisfluency: { key: '#', ctrl: false, alt: true, shift: false, label: 'Alt+#' },
  tagDiscontinuity: { key: '.', ctrl: false, alt: true, shift: false, label: 'Alt+.' },
  tagInterjection: { key: 'i', ctrl: false, alt: true, shift: false, label: 'Alt+I' },
  tagNonEnglish: { key: 'e', ctrl: false, alt: true, shift: false, label: 'Alt+E' },
  tagStutter: { key: '-', ctrl: false, alt: true, shift: false, label: 'Alt+-' },
  tagUnclear: { key: 'u', ctrl: false, alt: true, shift: false, label: 'Alt+U' }
};

const BROWSER_SAFE_PRESET = {
  ...DEFAULT_SHORTCUTS,
  snap: { key: 'w', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+W' },
  snapTrim: { key: 'e', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+E' },
  addUtterance: { key: 'a', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+A' },
  transcribe: { key: 't', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+T' },
  grammar: { key: 'g', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+G' },
  split: { key: 's', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+S' },
  mergeNext: { key: 'm', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+M' },
  delete: { key: 'd', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+D' },
  audioMode: { key: 'm', ctrl: false, alt: true, shift: true, label: 'Alt+Shift+M' }
};

class TranscriptApp {
  constructor() {
    this.session = null;
    this.activeParticipant = null;
    this.currentIndex = -1;
    this.audioMode = 'solo';
    this.playbackRate = 1.2;

    // Autoplay mode toggle (persisted in localStorage)
    this.autoplayEnabled = localStorage.getItem('transcript_autoplay') === 'true';

    // Track modification state for autosave
    this.hasUnsavedChanges = false;
    this.autosaveInterval = null;

    // Multi-track audio players
    this.audioPlayers = {};
    this.isPlaying = false;
    this.playEndTime = 0.0;
    this.playbackInterval = null;

    // Undo / Redo history
    this.historyStack = [];
    this.redoStack = [];

    // Shortcuts
    this.shortcuts = this.loadShortcuts();
    this.recordingAction = null;

    // View Panel Preferences (Spectrogram & Multitrack Overview)
    // Spectrogram is DISABLED by default to prevent heavy loading & lag
    this.showSpectrogram = localStorage.getItem('transcript_show_spectrogram') === 'true'; // default OFF
    this.showOverview = localStorage.getItem('transcript_show_overview') === 'true'; // default OFF

    // Volume Preference
    this.currentVolume = parseFloat(localStorage.getItem('transcript_volume') || '1.0');

    // Spectrogram Color Preference ('magma' or 'bw')
    this.spectrogramColor = localStorage.getItem('transcript_spectrogram_color') || 'magma';

    // Missing Utterance Candidates & Session Cache
    this.missingCandidates = [];
    this.missingScanCache = {};
    this.missingFilter = 'all';

    // Remember last active annotation index per participant
    this.participantActiveIndices = {};

    // Waveform & Spectrogram viewer
    this.waveform = new WaveformViewer('waveformCanvas', 'waveformContainer', 'spectrogramCanvas', 'spectrogramContainer');
    this.waveform.setSpectrogramColorScheme(this.spectrogramColor);
    this.waveform.onSelectionChange = (start, end) => this.onManualBoundsChange(start, end);
    this.waveform.onSeek = (timeSec) => this.seekAudio(timeSec);
    this.waveform.onRequestWindowPeaks = (startSec, endSec) => this.fetchWindowPeaks(startSec, endSec);
    this.waveform.onSelectAnnotation = (index) => this.selectUtterance(index);
    this.waveform.onViewChange = (start, end, duration) => this.onWaveformViewChange(start, end, duration);

    this.cacheDom();
    this.setupSidebarResizer();
    this.applyViewPanelPreferences();
    this.bindEvents();
    this.bindKeyboardShortcuts();
    this.updateShortcutBadges();
    this.updateAutoplayButton();
    this.setupAutosaveTimer();
    this.restoreSessionState();
    this.fetchAsrInfo();
  }

  cacheDom() {
    this.dom = {
      sessionDirInput: document.getElementById('sessionDirInput'),
      btnBrowseFolder: document.getElementById('btnBrowseFolder'),
      btnLoadSession: document.getElementById('btnLoadSession'),
      autosaveStatus: document.getElementById('autosaveStatus'),
      btnToggleAudioMode: document.getElementById('btnToggleAudioMode'),
      audioModeIcon: document.getElementById('audioModeIcon'),
      audioModeText: document.getElementById('audioModeText'),
      btnToggleAutoplay: document.getElementById('btnToggleAutoplay'),
      autoplayIcon: document.getElementById('autoplayIcon'),
      autoplayText: document.getElementById('autoplayText'),
      btnToggleSpectrogram: document.getElementById('btnToggleSpectrogram'),
      spectrogramToggleIcon: document.getElementById('spectrogramToggleIcon'),
      spectrogramToggleText: document.getElementById('spectrogramToggleText'),
      btnExportEaf: document.getElementById('btnExportEaf'),

      btnUndo: document.getElementById('btnUndo'),
      btnRedo: document.getElementById('btnRedo'),

      btnSaveActive: document.getElementById('btnSaveActive'),
      saveActiveTargetLabel: document.getElementById('saveActiveTargetLabel'),
      btnMoreSaveOptions: document.getElementById('btnMoreSaveOptions'),
      saveOptionsDropdown: document.getElementById('saveOptionsDropdown'),
      btnSaveAll: document.getElementById('btnSaveAll'),
      btnSaveAs: document.getElementById('btnSaveAs'),

      sidebar: document.getElementById('participantSidebar'),
      sidebarResizer: document.getElementById('sidebarResizer'),

      participantTabs: document.getElementById('participantTabs'),
      filterInput: document.getElementById('filterInput'),
      listStats: document.getElementById('listStats'),
      utteranceList: document.getElementById('utteranceList'),
      overviewTracks: document.getElementById('overviewTracks'),
      multitrackOverview: document.getElementById('multitrackOverview'),

      crosstalkBanner: document.getElementById('crosstalkBanner'),
      crosstalkTitle: document.getElementById('crosstalkTitle'),
      crosstalkDetail: document.getElementById('crosstalkDetail'),
      btnDeleteCrosstalk: document.getElementById('btnDeleteCrosstalk'),
      btnDismissCrosstalk: document.getElementById('btnDismissCrosstalk'),

      currentTimeDisplay: document.getElementById('currentTimeDisplay'),
      totalDurationDisplay: document.getElementById('totalDurationDisplay'),
      speedSelect: document.getElementById('speedSelect'),
      btnZoomOut: document.getElementById('btnZoomOut'),
      btnZoomReset: document.getElementById('btnZoomReset'),
      btnZoomIn: document.getElementById('btnZoomIn'),
      btnSeekBackward: document.getElementById('btnSeekBackward'),
      btnSeekForward: document.getElementById('btnSeekForward'),
      volumeSlider: document.getElementById('volumeSlider'),
      volumeIcon: document.getElementById('volumeIcon'),
      waveformScrollbar: document.getElementById('waveformScrollbar'),

      primaryActionsBar: document.getElementById('primaryActionsBar'),
      btnPlayPause: document.getElementById('btnPlayPause'),
      btnSnapEnlarge: document.getElementById('btnSnapEnlarge'),
      btnSnapTrim: document.getElementById('btnSnapTrim'),
      btnAddUtterance: document.getElementById('btnAddUtterance'),
      btnAutoTranscribe: document.getElementById('btnAutoTranscribe'),
      btnCorrectGrammar: document.getElementById('btnCorrectGrammar'),
      btnSplitPause: document.getElementById('btnSplitPause'),
      btnMergeNext: document.getElementById('btnMergeNext'),
      btnSearchMissing: document.getElementById('btnSearchMissing'),
      btnDeleteUtterance: document.getElementById('btnDeleteUtterance'),
      btnPrevUtterance: document.getElementById('btnPrevUtterance'),
      btnNextUtterance: document.getElementById('btnNextUtterance'),
      utteranceCounter: document.getElementById('utteranceCounter'),

      currentAnnoIndex: document.getElementById('currentAnnoIndex'),
      currentAnnoTimes: document.getElementById('currentAnnoTimes'),
      suggestionBadge: document.getElementById('suggestionBadge'),
      transcriptInput: document.getElementById('transcriptInput'),

      // Settings Modal
      btnTopShortcuts: document.getElementById('btnTopShortcuts'),
      btnSettingsOpenShortcuts: document.getElementById('btnSettingsOpenShortcuts'),
      btnOpenSettings: document.getElementById('btnOpenSettings'),
      btnFooterSettings: document.getElementById('btnFooterSettings'),
      settingsModal: document.getElementById('settingsModal'),
      btnCloseSettings: document.getElementById('btnCloseSettings'),
      btnSaveSettings: document.getElementById('btnSaveSettings'),
      settingsAsrModel: document.getElementById('settingsAsrModel'),
      settingsSpectrogramColor: document.getElementById('settingsSpectrogramColor'),
      settingToggleSpectrogram: document.getElementById('settingToggleSpectrogram'),
      settingToggleOverview: document.getElementById('settingToggleOverview'),
      settingsDeviceBadge: document.getElementById('settingsDeviceBadge'),
      settingsDeviceInfo: document.getElementById('settingsDeviceInfo'),

      // Save As Modal
      saveAsModal: document.getElementById('saveAsModal'),
      saveAsParticipantLabel: document.getElementById('saveAsParticipantLabel'),
      saveAsInput: document.getElementById('saveAsInput'),
      btnCloseSaveAs: document.getElementById('btnCloseSaveAs'),
      btnCancelSaveAs: document.getElementById('btnCancelSaveAs'),
      btnConfirmSaveAs: document.getElementById('btnConfirmSaveAs'),

      // Missing Utterances Modal
      missingUtterancesModal: document.getElementById('missingUtterancesModal'),
      missingSpeakerLabel: document.getElementById('missingSpeakerLabel'),
      btnCloseMissingUtterances: document.getElementById('btnCloseMissingUtterances'),
      btnRescanMissing: document.getElementById('btnRescanMissing'),
      missingSensitivitySelect: document.getElementById('missingSensitivitySelect'),
      filterMissingAll: document.getElementById('filterMissingAll'),
      filterMissingSpeech: document.getElementById('filterMissingSpeech'),
      filterMissingBleed: document.getElementById('filterMissingBleed'),
      missingScanningIndicator: document.getElementById('missingScanningIndicator'),
      missingResultsContainer: document.getElementById('missingResultsContainer'),
      btnInsertAllMissing: document.getElementById('btnInsertAllMissing'),
      btnCloseMissingFooter: document.getElementById('btnCloseMissingFooter'),

      shortcutsModal: document.getElementById('shortcutsModal'),
      shortcutsGrid: document.getElementById('shortcutsGrid'),
      btnOpenShortcutsModal: document.getElementById('btnOpenShortcutsModal'),
      btnCloseShortcuts: document.getElementById('btnCloseShortcuts'),
      btnSaveShortcuts: document.getElementById('btnSaveShortcuts'),
      btnResetShortcuts: document.getElementById('btnResetShortcuts'),
      btnPresetWorksInText: document.getElementById('btnPresetWorksInText'),

      toastNotification: document.getElementById('toastNotification')
    };
  }

  bindEvents() {
    this.dom.btnLoadSession.addEventListener('click', () => this.loadSession());
    if (this.dom.btnBrowseFolder) {
      this.dom.btnBrowseFolder.addEventListener('click', () => this.browseFolder());
    }
    this.dom.sessionDirInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.loadSession();
    });

    this.dom.btnToggleAudioMode.addEventListener('click', () => this.toggleAudioMode());
    this.dom.btnToggleAutoplay.addEventListener('click', () => this.toggleAutoplay());
    if (this.dom.btnToggleSpectrogram) {
      this.dom.btnToggleSpectrogram.addEventListener('click', () => this.toggleSpectrogram());
    }

    // Undo / Redo
    this.dom.btnUndo.addEventListener('click', () => this.undo());
    this.dom.btnRedo.addEventListener('click', () => this.redo());

    // Save Buttons & Dropdown
    this.dom.btnSaveActive.addEventListener('click', () => this.saveActiveParticipant());
    if (this.dom.btnMoreSaveOptions) {
      this.dom.btnMoreSaveOptions.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleSaveDropdown();
      });
    }
    document.addEventListener('click', () => this.toggleSaveDropdown(true));
    if (this.dom.saveOptionsDropdown) {
      this.dom.saveOptionsDropdown.addEventListener('click', (e) => e.stopPropagation());
    }
    this.dom.btnSaveAll.addEventListener('click', () => {
      this.toggleSaveDropdown(true);
      this.saveAllParticipants();
    });
    this.dom.btnSaveAs.addEventListener('click', () => {
      this.toggleSaveDropdown(true);
      this.openSaveAsModal();
    });
    this.dom.btnExportEaf.addEventListener('click', () => {
      this.toggleSaveDropdown(true);
      this.exportEaf();
    });

    // Settings Modal
    if (this.dom.btnTopShortcuts) {
      this.dom.btnTopShortcuts.addEventListener('click', () => this.openShortcutsModal());
    }
    if (this.dom.btnSettingsOpenShortcuts) {
      this.dom.btnSettingsOpenShortcuts.addEventListener('click', () => {
        this.closeSettingsModal();
        this.openShortcutsModal();
      });
    }
    if (this.dom.btnOpenSettings) this.dom.btnOpenSettings.addEventListener('click', () => this.openSettingsModal());
    if (this.dom.btnFooterSettings) this.dom.btnFooterSettings.addEventListener('click', () => this.openSettingsModal());
    if (this.dom.btnCloseSettings) this.dom.btnCloseSettings.addEventListener('click', () => this.closeSettingsModal());
    if (this.dom.btnSaveSettings) this.dom.btnSaveSettings.addEventListener('click', () => this.closeSettingsModal());
    if (this.dom.settingsAsrModel) {
      this.dom.settingsAsrModel.addEventListener('change', () => {
        localStorage.setItem('transcript_asr_model', this.dom.settingsAsrModel.value);
        const label = this.dom.settingsAsrModel.options[this.dom.settingsAsrModel.selectedIndex]?.text || this.dom.settingsAsrModel.value;
        this.showToast(`Selected ASR Model: ${label}`);
      });
    }

    if (this.dom.settingsSpectrogramColor) {
      this.dom.settingsSpectrogramColor.value = this.spectrogramColor;
      this.dom.settingsSpectrogramColor.addEventListener('change', () => {
        this.spectrogramColor = this.dom.settingsSpectrogramColor.value;
        localStorage.setItem('transcript_spectrogram_color', this.spectrogramColor);
        this.waveform.setSpectrogramColorScheme(this.spectrogramColor);
        this.showToast(`Spectrogram: ${this.spectrogramColor === 'bw' ? 'Black & White' : 'Voice Magma'}`);
      });
    }

    if (this.dom.settingToggleSpectrogram) {
      this.dom.settingToggleSpectrogram.addEventListener('change', () => {
        this.showSpectrogram = this.dom.settingToggleSpectrogram.checked;
        localStorage.setItem('transcript_show_spectrogram', this.showSpectrogram ? 'true' : 'false');
        this.waveform.setSpectrogramVisible(this.showSpectrogram);
        this.updateSpectrogramToggleButton();
        this.showToast(`Voice Spectrogram ${this.showSpectrogram ? 'Enabled' : 'Disabled'}`);
      });
    }

    if (this.dom.settingToggleOverview) {
      this.dom.settingToggleOverview.addEventListener('change', () => {
        this.showOverview = this.dom.settingToggleOverview.checked;
        localStorage.setItem('transcript_show_overview', this.showOverview ? 'true' : 'false');
        if (this.dom.multitrackOverview) {
          this.dom.multitrackOverview.classList.toggle('hidden', !this.showOverview);
        }
        this.showToast(`Session Overview ${this.showOverview ? 'Enabled' : 'Disabled'}`);
      });
    }

    // Save As Modal
    this.dom.btnCloseSaveAs.addEventListener('click', () => this.closeSaveAsModal());
    this.dom.btnCancelSaveAs.addEventListener('click', () => this.closeSaveAsModal());
    this.dom.btnConfirmSaveAs.addEventListener('click', () => this.confirmSaveAs());

    // Missing Utterances Modal
    if (this.dom.btnCloseMissingUtterances) {
      this.dom.btnCloseMissingUtterances.addEventListener('click', () => this.closeMissingUtterancesModal());
    }
    if (this.dom.btnCloseMissingFooter) {
      this.dom.btnCloseMissingFooter.addEventListener('click', () => this.closeMissingUtterancesModal());
    }
    if (this.dom.btnRescanMissing) {
      this.dom.btnRescanMissing.addEventListener('click', () => this.rescanMissingUtterances(true));
    }
    if (this.dom.filterMissingAll) {
      this.dom.filterMissingAll.addEventListener('click', () => this.setMissingFilter('all'));
    }
    if (this.dom.filterMissingSpeech) {
      this.dom.filterMissingSpeech.addEventListener('click', () => this.setMissingFilter('speech'));
    }
    if (this.dom.filterMissingBleed) {
      this.dom.filterMissingBleed.addEventListener('click', () => this.setMissingFilter('bleed'));
    }
    if (this.dom.missingSensitivitySelect) {
      this.dom.missingSensitivitySelect.addEventListener('change', () => this.rescanMissingUtterances(true));
    }
    if (this.dom.btnInsertAllMissing) {
      this.dom.btnInsertAllMissing.addEventListener('click', () => this.insertAllMissingCandidates());
    }

    // Shortcuts Modal
    this.dom.btnOpenShortcutsModal.addEventListener('click', () => this.openShortcutsModal());
    this.dom.btnCloseShortcuts.addEventListener('click', () => this.closeShortcutsModal());
    this.dom.btnSaveShortcuts.addEventListener('click', () => this.closeShortcutsModal());
    this.dom.btnResetShortcuts.addEventListener('click', () => this.resetShortcuts());
    if (this.dom.btnPresetWorksInText) {
      this.dom.btnPresetWorksInText.addEventListener('click', () => this.applyPresetWorksWhileTyping());
    }

    // Playback & Zoom
    this.dom.speedSelect.addEventListener('change', (e) => {
      this.playbackRate = parseFloat(e.target.value);
      this.updateAudioPlaybackRate();
    });

    this.dom.btnZoomIn.addEventListener('click', () => this.waveform.zoomIn());
    this.dom.btnZoomOut.addEventListener('click', () => this.waveform.zoomOut());
    if (this.dom.btnZoomReset) {
      this.dom.btnZoomReset.addEventListener('click', () => this.waveform.resetZoom());
    }

    // Media Seek (Backward / Forward 2s) & Volume Controls
    if (this.dom.btnSeekBackward) {
      this.dom.btnSeekBackward.addEventListener('click', () => this.seekBackward(2.0));
    }
    if (this.dom.btnSeekForward) {
      this.dom.btnSeekForward.addEventListener('click', () => this.seekForward(2.0));
    }
    if (this.dom.volumeSlider) {
      this.dom.volumeSlider.value = this.currentVolume;
      this.dom.volumeSlider.addEventListener('input', (e) => this.setVolume(parseFloat(e.target.value)));
    }
    if (this.dom.volumeIcon) {
      this.dom.volumeIcon.addEventListener('click', () => {
        if (this.currentVolume > 0) {
          this.previousVolume = this.currentVolume;
          this.setVolume(0);
        } else {
          this.setVolume(this.previousVolume || 1.0);
        }
      });
    }

    // Timeline Scrollbar
    this.dom.waveformScrollbar.addEventListener('input', (e) => {
      const frac = parseFloat(e.target.value) / 1000;
      this.waveform.panToFraction(frac);
    });

    // Primary Action Buttons Drag-and-Drop Reordering
    this.setupActionButtonsDragAndDrop();

    this.dom.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    if (this.dom.btnReplay) this.dom.btnReplay.addEventListener('click', () => this.replayUtterance());
    if (this.dom.btnSnapEnlarge) this.dom.btnSnapEnlarge.addEventListener('click', () => this.snapToWave('expand'));
    if (this.dom.btnSnapTrim) this.dom.btnSnapTrim.addEventListener('click', () => this.snapToWave('trim'));
    if (this.dom.btnAddUtterance) this.dom.btnAddUtterance.addEventListener('click', () => this.addUtterance());
    if (this.dom.btnAutoTranscribe) this.dom.btnAutoTranscribe.addEventListener('click', () => this.autoTranscribeActive());
    if (this.dom.btnCorrectGrammar) this.dom.btnCorrectGrammar.addEventListener('click', () => this.correctGrammar());
    if (this.dom.btnSplitPause) this.dom.btnSplitPause.addEventListener('click', () => this.splitUtterance());
    if (this.dom.btnMergeNext) this.dom.btnMergeNext.addEventListener('click', () => this.mergeWithNext());
    if (this.dom.btnSearchMissing) this.dom.btnSearchMissing.addEventListener('click', () => this.openMissingUtterancesModal());
    if (this.dom.btnDeleteUtterance) this.dom.btnDeleteUtterance.addEventListener('click', () => this.deleteCurrentUtterance());
    if (this.dom.btnDeleteCrosstalk) this.dom.btnDeleteCrosstalk.addEventListener('click', () => this.deleteCurrentUtterance());
    if (this.dom.btnDismissCrosstalk) this.dom.btnDismissCrosstalk.addEventListener('click', () => this.hideCrosstalkBanner());

    this.dom.btnPrevUtterance.addEventListener('click', () => this.prevUtterance());
    this.dom.btnNextUtterance.addEventListener('click', () => this.nextUtterance());

    // Text editing
    this.dom.transcriptInput.addEventListener('focus', () => {
      this.textBeforeFocus = this.dom.transcriptInput.value;
    });

    this.dom.transcriptInput.addEventListener('blur', () => {
      if (this.currentUtterance && this.textBeforeFocus !== this.dom.transcriptInput.value) {
        this.pushHistoryState('Edit text');
        this.markUnsaved();
      }
    });

    this.dom.transcriptInput.addEventListener('input', () => {
      if (this.currentUtterance) {
        this.currentUtterance.text = this.dom.transcriptInput.value;
        this.updateUtteranceInList(this.currentIndex);
        this.markUnsaved();
      }
    });

    // Guideline tag buttons
    document.querySelectorAll('.tag-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.getAttribute('data-tag');
        this.applyGuidelineTag(tag);
      });
    });

    this.dom.filterInput.addEventListener('input', () => this.renderUtteranceList());
  }

  applyViewPanelPreferences() {
    if (this.dom.settingToggleSpectrogram) {
      this.dom.settingToggleSpectrogram.checked = this.showSpectrogram;
    }
    if (this.dom.settingToggleOverview) {
      this.dom.settingToggleOverview.checked = this.showOverview;
    }
    this.waveform.setSpectrogramVisible(this.showSpectrogram);
    this.updateSpectrogramToggleButton();
    if (this.dom.multitrackOverview) {
      this.dom.multitrackOverview.classList.toggle('hidden', !this.showOverview);
    }
  }

  toggleSpectrogram() {
    this.showSpectrogram = !this.showSpectrogram;
    localStorage.setItem('transcript_show_spectrogram', this.showSpectrogram ? 'true' : 'false');
    if (this.dom.settingToggleSpectrogram) {
      this.dom.settingToggleSpectrogram.checked = this.showSpectrogram;
    }
    this.waveform.setSpectrogramVisible(this.showSpectrogram);
    this.updateSpectrogramToggleButton();
    this.showToast(`Spectrogram: ${this.showSpectrogram ? 'ENABLED' : 'DISABLED'}`);
  }

  updateSpectrogramToggleButton() {
    if (!this.dom.btnToggleSpectrogram) return;
    if (this.showSpectrogram) {
      this.dom.btnToggleSpectrogram.classList.add('active');
      this.dom.spectrogramToggleIcon.textContent = '📊';
      this.dom.spectrogramToggleText.textContent = 'Spectrogram: ON';
    } else {
      this.dom.btnToggleSpectrogram.classList.remove('active');
      this.dom.spectrogramToggleIcon.textContent = '📊';
      this.dom.spectrogramToggleText.textContent = 'Spectrogram: Off';
    }
  }

  // ---------------- Reorderable Action Buttons (Drag & Drop) ----------------

  setupActionButtonsDragAndDrop() {
    const bar = this.dom.primaryActionsBar;
    if (!bar) return;

    // 1. Restore saved order from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem('transcript_action_buttons_order') || 'null');
      if (Array.isArray(saved) && saved.length > 0) {
        const currentBtns = Array.from(bar.querySelectorAll('button[data-action-id]'));
        const btnMap = new Map(currentBtns.map((b) => [b.getAttribute('data-action-id'), b]));
        saved.forEach((id) => {
          const btn = btnMap.get(id);
          if (btn) {
            bar.appendChild(btn);
            btnMap.delete(id);
          }
        });
        // Append any newly added buttons
        btnMap.forEach((btn) => bar.appendChild(btn));
      }
    } catch (e) {
      console.warn('Failed restoring button order:', e);
    }

    // 2. Drag & Drop Event Handlers
    let draggedBtn = null;

    const saveOrder = () => {
      const order = Array.from(bar.querySelectorAll('button[data-action-id]'))
        .map((b) => b.getAttribute('data-action-id'))
        .filter(Boolean);
      localStorage.setItem('transcript_action_buttons_order', JSON.stringify(order));
    };

    bar.addEventListener('dragstart', (e) => {
      const btn = e.target.closest('button[data-action-id]');
      if (!btn) return;
      draggedBtn = btn;
      btn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', btn.getAttribute('data-action-id') || '');
    });

    bar.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetBtn = e.target.closest('button[data-action-id]');
      if (!targetBtn || targetBtn === draggedBtn) return;

      const rect = targetBtn.getBoundingClientRect();
      const isAfter = (e.clientX - rect.left) > (rect.width / 2);
      if (isAfter) {
        targetBtn.after(draggedBtn);
      } else {
        targetBtn.before(draggedBtn);
      }
    });

    bar.addEventListener('dragenter', (e) => {
      const targetBtn = e.target.closest('button[data-action-id]');
      if (targetBtn && targetBtn !== draggedBtn) {
        targetBtn.classList.add('drag-over');
      }
    });

    bar.addEventListener('dragleave', (e) => {
      const targetBtn = e.target.closest('button[data-action-id]');
      if (targetBtn) {
        targetBtn.classList.remove('drag-over');
      }
    });

    bar.addEventListener('drop', (e) => {
      e.preventDefault();
      bar.querySelectorAll('button[data-action-id]').forEach((b) => b.classList.remove('drag-over'));
      saveOrder();
      this.showToast('Action buttons layout saved');
    });

    bar.addEventListener('dragend', () => {
      if (draggedBtn) draggedBtn.classList.remove('dragging');
      draggedBtn = null;
      bar.querySelectorAll('button[data-action-id]').forEach((b) => b.classList.remove('drag-over'));
      saveOrder();
    });
  }

  setupSidebarResizer() {
    const sidebar = this.dom.sidebar;
    const resizer = this.dom.sidebarResizer;
    if (!sidebar || !resizer) return;

    const savedWidth = localStorage.getItem('transcript_sidebar_width');
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10);
      if (!isNaN(parsed) && parsed >= 180 && parsed <= 650) {
        sidebar.style.width = `${parsed}px`;
      }
    }

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const onPointerMove = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidth = Math.max(180, Math.min(650, startWidth + dx));
      sidebar.style.width = `${newWidth}px`;
      if (this.waveform && this.waveform.onResize) {
        this.waveform.onResize();
      }
    };

    const onPointerUp = () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      const finalWidth = sidebar.getBoundingClientRect().width;
      localStorage.setItem('transcript_sidebar_width', Math.round(finalWidth).toString());
      if (this.waveform && this.waveform.onResize) {
        this.waveform.onResize();
      }
    };

    resizer.addEventListener('pointerdown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      resizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });
  }

  async browseFolder() {
    try {
      if (this.dom.btnBrowseFolder) {
        this.dom.btnBrowseFolder.disabled = true;
        this.dom.btnBrowseFolder.textContent = '⏳ Selecting...';
      }
      const initial = this.dom.sessionDirInput.value.trim();
      const res = await fetch('/api/browse_folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_dir: initial })
      });
      const data = await res.json();
      if (data.success && data.path) {
        this.dom.sessionDirInput.value = data.path;
        await this.loadSession();
        this.showToast(`📂 Selected session: ${data.path}`);
      }
    } catch (e) {
      console.error('Browse folder error:', e);
      alert('Error selecting folder: ' + e.message);
    } finally {
      if (this.dom.btnBrowseFolder) {
        this.dom.btnBrowseFolder.disabled = false;
        this.dom.btnBrowseFolder.textContent = '📂 Select Folder';
      }
    }
  }

  toggleSaveDropdown(forceClose = false) {
    if (!this.dom.saveOptionsDropdown) return;
    if (forceClose) {
      this.dom.saveOptionsDropdown.classList.add('hidden');
    } else {
      this.dom.saveOptionsDropdown.classList.toggle('hidden');
    }
  }

  get currentUtterance() {
    if (!this.session || !this.activeParticipant || this.currentIndex < 0) return null;
    const list = this.session.annotations[this.activeParticipant] || [];
    return list[this.currentIndex] || null;
  }

  // ---------------- State Persistence (Restore on Reopen) ----------------

  saveSessionState() {
    if (!this.session) return;
    try {
      const state = {
        sessionDir: this.session.session_dir,
        activeParticipant: this.activeParticipant,
        currentIndex: this.currentIndex,
        participantActiveIndices: this.participantActiveIndices,
        timestamp: Date.now()
      };
      localStorage.setItem('transcript_review_last_state', JSON.stringify(state));
    } catch (e) {
      console.error('Error saving state:', e);
    }
  }

  async restoreSessionState() {
    try {
      const saved = localStorage.getItem('transcript_review_last_state');
      if (saved) {
        const state = JSON.parse(saved);
        if (state.participantActiveIndices && typeof state.participantActiveIndices === 'object') {
          this.participantActiveIndices = state.participantActiveIndices;
        }
        if (state.sessionDir) {
          this.dom.sessionDirInput.value = state.sessionDir;
          await this.loadSession(state.activeParticipant, state.currentIndex);
        }
      }
    } catch (e) {
      console.error('Error restoring session state:', e);
    }
  }

  // ---------------- Periodic Autosave Engine ----------------

  setupAutosaveTimer() {
    if (this.autosaveInterval) clearInterval(this.autosaveInterval);
    // Autosave every 45 seconds if changes occurred
    this.autosaveInterval = setInterval(() => {
      if (this.session && this.hasUnsavedChanges) {
        this.performBackgroundAutosave();
      }
    }, 45000);
  }

  markUnsaved() {
    this.hasUnsavedChanges = true;
    if (this.dom.autosaveStatus) {
      this.dom.autosaveStatus.textContent = '● Unsaved';
      this.dom.autosaveStatus.className = 'autosave-status unsaved';
    }
    this.saveSessionState();
  }

  markSaved() {
    this.hasUnsavedChanges = false;
    if (this.dom.autosaveStatus) {
      this.dom.autosaveStatus.textContent = '● Saved';
      this.dom.autosaveStatus.className = 'autosave-status saved';
    }
  }

  async performBackgroundAutosave() {
    if (!this.session) return;
    try {
      if (this.dom.autosaveStatus) {
        this.dom.autosaveStatus.textContent = '☁️ Autosaving...';
      }
      const res = await fetch('/api/autosave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          all_annotations: this.session.annotations
        })
      });
      const data = await res.json();
      if (data.success) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (this.dom.autosaveStatus) {
          this.dom.autosaveStatus.textContent = `● Autosaved ${timeStr}`;
          this.dom.autosaveStatus.className = 'autosave-status saved';
        }
      }
    } catch (e) {
      console.error('Autosave error:', e);
    }
  }

  // ---------------- Session Loading ----------------

  async loadSession(targetParticipant = null, targetIndex = -1) {
    const dir = this.dom.sessionDirInput.value.trim();
    if (!dir) {
      alert('Please enter an experiment session folder path.');
      return;
    }

    try {
      this.dom.btnLoadSession.disabled = true;
      this.dom.btnLoadSession.textContent = 'Loading...';

      const res = await fetch('/api/load_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_dir: dir })
      });
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load session: ' + (data.error || 'Unknown error'));
        return;
      }

      this.session = data;
      this.missingScanCache = {};
      this.historyStack = [];
      this.redoStack = [];
      this.updateUndoRedoButtons();
      this.markSaved();
      if (this.dom.btnLocateFolder) {
        this.dom.btnLocateFolder.disabled = false;
      }

      this.setupAudioPlayers();
      this.renderParticipantTabs();
      this.renderMultitrackOverview();

      // Restore specified participant or default to first
      const pToSelect = (targetParticipant && data.participants.includes(targetParticipant))
        ? targetParticipant
        : (data.participants && data.participants.length > 0 ? data.participants[0] : null);

      if (pToSelect) {
        await this.selectParticipant(pToSelect);
        if (targetIndex >= 0) {
          this.selectUtterance(targetIndex);
        }
      }
      this.showToast(`Loaded ${data.participants.length} participant tracks`);
      this.saveSessionState();
    } catch (err) {
      console.error(err);
      alert('Error connecting to local server: ' + err.message);
    } finally {
      this.dom.btnLoadSession.disabled = false;
      this.dom.btnLoadSession.textContent = 'Load Session';
    }
  }

  setupAudioPlayers() {
    Object.values(this.audioPlayers).forEach((p) => p.pause());
    this.audioPlayers = {};

    this.session.participants.forEach((pId) => {
      const audio = new Audio(`/api/audio?participant=${encodeURIComponent(pId)}`);
      audio.preload = 'auto';
      audio.playbackRate = this.playbackRate;
      audio.volume = this.currentVolume;
      this.audioPlayers[pId] = audio;
    });
  }

  renderParticipantTabs() {
    this.dom.participantTabs.innerHTML = '';
    this.session.participants.forEach((pId, idx) => {
      const tab = document.createElement('div');
      tab.className = `participant-tab ${pId === this.activeParticipant ? 'active' : ''}`;
      const srtName = (this.session.srt_filenames && this.session.srt_filenames[pId]) || `${pId}.srt`;
      tab.textContent = `${srtName}`;
      tab.title = `Switch to ${srtName} (Press ${idx + 1})`;
      tab.addEventListener('click', () => this.selectParticipant(pId));
      this.dom.participantTabs.appendChild(tab);
    });
  }

  async selectParticipant(pId) {
    if (this.activeParticipant === pId && this.currentIndex >= 0) return;
    this.pauseAudio();

    // Preserve previous participant's active index
    if (this.activeParticipant && this.currentIndex >= 0) {
      this.participantActiveIndices[this.activeParticipant] = this.currentIndex;
    }

    this.activeParticipant = pId;
    this.waveform.activeParticipant = pId;
    this.currentIndex = -1;

    const activeSrtName = (this.session && this.session.srt_filenames && this.session.srt_filenames[pId]) || `${pId}.srt`;
    this.dom.saveActiveTargetLabel.textContent = `${activeSrtName} (Ctrl+S)`;

    document.querySelectorAll('.participant-tab').forEach((tab, idx) => {
      tab.classList.toggle('active', this.session.participants[idx] === pId);
    });

    try {
      const res = await fetch(`/api/waveform?participant=${encodeURIComponent(pId)}&points=1600`);
      const wfData = await res.json();
      this.waveform.setGlobalData(wfData.peaks, wfData.duration, wfData.sample_rate);
      this.dom.totalDurationDisplay.textContent = this.formatTime(wfData.duration);
    } catch (e) {
      console.error('Error fetching global waveform:', e);
    }

    this.renderUtteranceList();
    this.renderMultitrackOverview();

    const list = this.session.annotations[pId] || [];
    if (list.length > 0) {
      const savedIdx = this.participantActiveIndices[pId] !== undefined ? this.participantActiveIndices[pId] : 0;
      const safeIdx = Math.max(0, Math.min(savedIdx, list.length - 1));
      this.selectUtterance(safeIdx);
    }
    this.saveSessionState();
  }

  async fetchWindowPeaks(startSec, endSec) {
    if (!this.session || !this.activeParticipant) return;
    try {
      const margin = 1.0;
      const s = Math.max(0, startSec - margin);
      const e = Math.min(this.waveform.duration, endSec + margin);

      const res = await fetch(`/api/waveform?participant=${encodeURIComponent(this.activeParticipant)}&start=${s}&end=${e}&points=1000`);
      const data = await res.json();
      if (data.is_window && data.peaks) {
        this.waveform.setWindowPeaks(data.peaks, data.start, data.end);
      }
    } catch (err) {
      console.error('Error fetching window peaks:', err);
    }
  }

  // ---------------- Utterance Selection & Inspection ----------------

  selectUtterance(index, triggerAutoplay = true) {
    const list = this.session.annotations[this.activeParticipant] || [];
    if (index < 0 || index >= list.length) return;

    this.currentIndex = index;
    if (this.activeParticipant) {
      this.participantActiveIndices[this.activeParticipant] = index;
    }
    const anno = list[index];

    this.dom.currentAnnoIndex.textContent = `Utterance #${index + 1}`;
    const dur = (anno.end - anno.start).toFixed(2);
    this.dom.currentAnnoTimes.textContent = `${this.formatTime(anno.start)} ➔ ${this.formatTime(anno.end)} (${dur}s)`;
    this.dom.transcriptInput.value = anno.text;
    this.dom.utteranceCounter.textContent = `${index + 1} / ${list.length}`;

    // Pass all annotations to waveform: Active in Orange, Inactive in Blue
    this.waveform.setAnnotations(list, this.currentIndex, true);

    document.querySelectorAll('.utterance-item').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
    const activeEl = document.querySelector(`.utterance-item[data-index="${index}"]`);
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });

    this.saveSessionState();

    if (this.autoplayEnabled && triggerAutoplay) {
      this.playUtterance();
    }
  }

  toggleAutoplay() {
    this.autoplayEnabled = !this.autoplayEnabled;
    localStorage.setItem('transcript_autoplay', this.autoplayEnabled ? 'true' : 'false');
    this.updateAutoplayButton();
    this.showToast(`Autoplay ${this.autoplayEnabled ? 'ENABLED: audio will play on navigation' : 'DISABLED'}`);
  }

  updateAutoplayButton() {
    if (!this.dom.btnToggleAutoplay) return;
    if (this.autoplayEnabled) {
      this.dom.btnToggleAutoplay.classList.add('active');
      this.dom.autoplayIcon.textContent = '🔊';
      this.dom.autoplayText.textContent = 'Autoplay: ON';
    } else {
      this.dom.btnToggleAutoplay.classList.remove('active');
      this.dom.autoplayIcon.textContent = '🔇';
      this.dom.autoplayText.textContent = 'Autoplay: Off';
    }
  }

  onWaveformViewChange(viewStart, viewEnd, duration) {
    if (!this.dom.waveformScrollbar || duration <= 0) return;
    const span = viewEnd - viewStart;
    const maxStart = Math.max(0.001, duration - span);
    const frac = Math.max(0, Math.min(1, viewStart / maxStart));
    this.dom.waveformScrollbar.value = Math.round(frac * 1000);
  }

  checkBackchannelSuggestion(text) {
    const clean = text.toLowerCase().trim().replace(/[.,!?;:]/g, '');
    const agreementTokens = ['uh-huh', 'uh huh', 'mhm', 'yeah', 'yep', 'yes', 'mm', 'right', 'okay', 'sure'];
    if (agreementTokens.includes(clean)) {
      this.dom.suggestionBadge.textContent = `Suggested: @ Backchannel (Press Alt+B)`;
      this.dom.suggestionBadge.classList.remove('hidden');
    } else {
      this.dom.suggestionBadge.classList.add('hidden');
    }
  }

  async checkCrosstalk(startSec, endSec) {
    if (!this.session || !this.activeParticipant) return;
    try {
      const res = await fetch('/api/crosstalk_check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          start: startSec,
          end: endSec,
          threshold_db: 9.0
        })
      });
      const data = await res.json();

      if (data.success && data.is_crosstalk) {
        this.dom.crosstalkTitle.textContent = `⚠️ Suspected Bleed from ${data.dominant_speaker}`;
        this.dom.crosstalkDetail.textContent = `Mic ${data.dominant_speaker} is +${data.energy_diff_db} dB louder during this segment.`;
        this.dom.crosstalkBanner.classList.remove('hidden');

        const activeEl = document.querySelector(`.utterance-item[data-index="${this.currentIndex}"]`);
        if (activeEl) activeEl.classList.add('is-crosstalk');
      } else {
        this.hideCrosstalkBanner();
      }
    } catch (e) {
      console.error('Crosstalk check error:', e);
    }
  }

  hideCrosstalkBanner() {
    this.dom.crosstalkBanner.classList.add('hidden');
  }

  // ---------------- Undo / Redo Engine ----------------

  pushHistoryState(actionDescription = 'Change') {
    if (!this.session || !this.activeParticipant) return;
    const list = this.session.annotations[this.activeParticipant] || [];
    this.historyStack.push({
      action: actionDescription,
      participant: this.activeParticipant,
      currentIndex: this.currentIndex,
      annotations: JSON.parse(JSON.stringify(list))
    });
    if (this.historyStack.length > 50) this.historyStack.shift();
    this.redoStack = [];
    this.updateUndoRedoButtons();
    this.markUnsaved();
  }

  undo() {
    if (this.historyStack.length === 0) return;
    const currentState = {
      action: 'Current',
      participant: this.activeParticipant,
      currentIndex: this.currentIndex,
      annotations: JSON.parse(JSON.stringify(this.session.annotations[this.activeParticipant]))
    };
    this.redoStack.push(currentState);

    const prevState = this.historyStack.pop();
    this.session.annotations[prevState.participant] = prevState.annotations;
    this.activeParticipant = prevState.participant;
    this.currentIndex = prevState.currentIndex;

    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(this.currentIndex);
    this.updateUndoRedoButtons();
    this.markUnsaved();
    this.showToast(`↩️ Undid: ${prevState.action}`);
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const currentState = {
      action: 'Current',
      participant: this.activeParticipant,
      currentIndex: this.currentIndex,
      annotations: JSON.parse(JSON.stringify(this.session.annotations[this.activeParticipant]))
    };
    this.historyStack.push(currentState);

    const nextState = this.redoStack.pop();
    this.session.annotations[nextState.participant] = nextState.annotations;
    this.activeParticipant = nextState.participant;
    this.currentIndex = nextState.currentIndex;

    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(this.currentIndex);
    this.updateUndoRedoButtons();
    this.markUnsaved();
    this.showToast(`↪️ Redid: ${nextState.action}`);
  }

  updateUndoRedoButtons() {
    this.dom.btnUndo.disabled = this.historyStack.length === 0;
    this.dom.btnRedo.disabled = this.redoStack.length === 0;
  }

  // ---------------- Waveform Snapping with Strict No-Overlap (Expand & Trim) ----------------

  async snapToWave(mode = 'expand') {
    const anno = this.currentUtterance;
    if (!anno) return;

    const isTrim = mode === 'trim';
    this.pushHistoryState(isTrim ? 'Snap (trim)' : 'Snap (enlarge)');

    const btn = isTrim ? this.dom.btnSnapTrim : this.dom.btnSnapEnlarge;
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.textContent = isTrim ? '✂️ Trimming...' : '⚡ Snapping...';
      btn.disabled = true;
    }

    try {
      const res = await fetch('/api/snap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          start: anno.start,
          end: anno.end,
          safety_padding_ms: isTrim ? 10.0 : 50.0,
          margin_db: isTrim ? 14.0 : 6.0,
          mode: mode
        })
      });
      const data = await res.json();

      if (data.success) {
        // Enforce No Overlap against neighboring annotations
        const list = this.session.annotations[this.activeParticipant];
        const prevAnno = this.currentIndex > 0 ? list[this.currentIndex - 1] : null;
        const nextAnno = this.currentIndex < list.length - 1 ? list[this.currentIndex + 1] : null;

        const minStart = prevAnno ? (prevAnno.end + 0.005) : 0.0;
        const maxEnd = nextAnno ? (nextAnno.start - 0.005) : this.waveform.duration;

        let snappedStart = Math.max(minStart, data.new_start);
        let snappedEnd = Math.min(maxEnd, data.new_end);

        if (snappedEnd <= snappedStart) {
          snappedStart = anno.start;
          snappedEnd = anno.end;
        }

        anno.start = roundTime(snappedStart);
        anno.end = roundTime(snappedEnd);

        this.waveform.setAnnotations(list, this.currentIndex, false);
        const dur = (anno.end - anno.start).toFixed(2);
        this.dom.currentAnnoTimes.textContent = `${this.formatTime(anno.start)} ➔ ${this.formatTime(anno.end)} (${dur}s)`;
        this.updateUtteranceInList(this.currentIndex);
        this.markUnsaved();

        const actionName = isTrim ? '✂️ Trimmed to wave burst' : '⚡ Enlarged to wave';
        this.showToast(`${actionName}: Δstart ${data.delta_start_ms > 0 ? '+' : ''}${data.delta_start_ms}ms, Δend ${data.delta_end_ms > 0 ? '+' : ''}${data.delta_end_ms}ms`);

        if (data.has_internal_pause && data.split_point) {
          this.dom.btnSplitPause.style.borderColor = '#f59e0b';
          this.dom.btnSplitPause.textContent = `✂️ Split Pause @ ${this.formatTime(data.split_point)}`;
          this.pendingSplitPoint = data.split_point;
        }
      } else {
        this.showToast('Snap error: ' + (data.error || 'Failed'));
      }
    } catch (e) {
      console.error('Snap error:', e);
      this.showToast('Failed to snap: ' + e.message);
    } finally {
      if (btn) {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      }
    }
  }

  // ---------------- Offline Grammar & Punctuation Correction ----------------

  async correctGrammar() {
    const anno = this.currentUtterance;
    if (!anno) {
      this.showToast('No active utterance selected');
      return;
    }
    const currentText = (this.dom.transcriptInput ? this.dom.transcriptInput.value : '') || anno.text || '';
    if (!currentText.trim()) {
      this.showToast('Utterance text is empty');
      return;
    }

    const btn = this.dom.btnCorrectGrammar;
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.classList.add('loading');
      btn.innerHTML = '✨ Fixing...';
      btn.disabled = true;
    }

    try {
      const res = await fetch('/api/correct_grammar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: currentText })
      });
      const data = await res.json();
      if (data.success) {
        const corrected = data.corrected_text || data.corrected || currentText;
        if (corrected !== currentText) {
          this.pushHistoryState('Correct grammar');
          anno.text = corrected;
          this.dom.transcriptInput.value = corrected;
          this.updateUtteranceInList(this.currentIndex);
          this.markUnsaved();
          this.showToast(`✨ Grammar corrected: "${corrected}"`);
        } else {
          this.showToast('✨ Text is already grammatically clean!');
        }
      } else {
        this.showToast('Grammar correction error: ' + (data.error || 'Failed'));
      }
    } catch (err) {
      console.error('Grammar error:', err);
      this.showToast('Failed to correct grammar: ' + err.message);
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.innerHTML = origHtml;
        btn.disabled = false;
      }
    }
  }

  // ---------------- Adding New Utterance (Strict No-Overlap) ----------------

  addUtterance() {
    if (!this.session || !this.activeParticipant) {
      this.showToast('Please load a session first');
      return;
    }

    const list = this.session.annotations[this.activeParticipant] || [];
    const maxDuration = this.waveform.duration || 60.0;

    // Desired anchor time: cursor playhead position or right after current utterance
    let targetTime = 0.0;
    if (this.waveform.playheadSec > 0 && this.waveform.playheadSec < maxDuration) {
      targetTime = this.waveform.playheadSec;
    } else if (this.currentUtterance) {
      targetTime = this.currentUtterance.end + 0.05;
    } else if (list.length > 0) {
      targetTime = list[list.length - 1].end + 0.05;
    }

    // Sort existing annotations
    list.sort((a, b) => a.start - b.start);

    let start = targetTime;
    let end = start + 1.5;

    // If targetTime falls inside an existing utterance, advance to its end
    for (const a of list) {
      if (start >= a.start && start < a.end) {
        start = a.end + 0.05;
        end = start + 1.5;
      }
    }

    // Check collision with next utterance
    const nextCollision = list.find((a) => a.start > start);
    if (nextCollision) {
      if (start >= nextCollision.start - 0.05) {
        // Find next free gap of at least 0.3s
        let foundGap = false;
        for (let i = 0; i < list.length; i++) {
          const gapStart = list[i].end + 0.05;
          const gapEnd = (i < list.length - 1) ? list[i + 1].start - 0.05 : maxDuration;
          if (gapEnd - gapStart >= 0.3) {
            start = gapStart;
            end = Math.min(gapEnd, start + 1.5);
            foundGap = true;
            break;
          }
        }
        if (!foundGap) {
          start = list[list.length - 1].end + 0.05;
          end = Math.min(maxDuration, start + 1.5);
        }
      } else {
        end = Math.min(end, nextCollision.start - 0.05);
      }
    }

    start = roundTime(Math.max(0, start));
    end = roundTime(Math.min(maxDuration, end));

    if (end <= start + 0.05) {
      this.showToast('No free space to insert utterance without overlapping');
      return;
    }

    this.pushHistoryState('Add utterance');

    const newAnno = {
      id: list.length + 1,
      start: start,
      end: end,
      text: ''
    };

    list.push(newAnno);
    list.sort((a, b) => a.start - b.start);
    list.forEach((item, idx) => { item.id = idx + 1; });

    const newIndex = list.indexOf(newAnno);

    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(newIndex, false);
    this.dom.transcriptInput.focus();
    this.markUnsaved();
    this.showToast(`➕ Added utterance #${newIndex + 1} (${start.toFixed(2)}s ➔ ${end.toFixed(2)}s)`);
  }

  // ---------------- Auto-Transcribe Active Annotation ----------------

  async autoTranscribeActive() {
    const anno = this.currentUtterance;
    if (!anno) {
      this.showToast('No active utterance selected');
      return;
    }

    const btn = this.dom.btnAutoTranscribe;
    const origText = btn.innerHTML;
    btn.classList.add('loading');
    btn.innerHTML = '⏳ Transcribing...';
    btn.disabled = true;

    try {
      const selectedModel = (this.dom.settingsAsrModel ? this.dom.settingsAsrModel.value : null) ||
                            localStorage.getItem('transcript_asr_model') ||
                            'openai/whisper-tiny';
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          start: anno.start,
          end: anno.end,
          model: selectedModel
        })
      });
      const data = await res.json();

      if (data.success) {
        let rawText = '';
        if (typeof data.text === 'string') {
          rawText = data.text;
        } else if (data.text && typeof data.text === 'object') {
          rawText = data.text.text || '';
        }
        const text = String(rawText || '').trim();

        if (text) {
          this.pushHistoryState('Auto-transcribe');
          anno.text = text;
          this.dom.transcriptInput.value = text;
          this.updateUtteranceInList(this.currentIndex);
          this.markUnsaved();
          const modelTag = data.model ? ` [${data.model.split('/').pop()}]` : '';
          this.showToast(`🎙️ Transcribed${modelTag}: "${text}"`);
        } else {
          this.showToast('No speech detected in this audio segment');
        }
      } else {
        this.showToast('Transcription error: ' + (data.error || 'Failed'));
      }
    } catch (err) {
      console.error('Auto-transcribe error:', err);
      this.showToast('Failed to transcribe: ' + err.message);
    } finally {
      btn.classList.remove('loading');
      btn.innerHTML = origText;
      btn.disabled = false;
    }
  }

  async fetchAsrInfo() {
    try {
      const res = await fetch('/api/asr_info');
      const data = await res.json();
      if (data.success) {
        if (this.dom.settingsDeviceBadge) {
          const isGpu = data.active_device === 'cuda';
          this.dom.settingsDeviceBadge.textContent = isGpu ? `⚡ GPU (${data.device_name || 'CUDA'})` : '💻 CPU';
          this.dom.settingsDeviceBadge.className = `device-badge ${isGpu ? 'badge-gpu' : 'badge-cpu'}`;
        }
        if (this.dom.settingsDeviceInfo) {
          const isGpu = data.active_device === 'cuda';
          this.dom.settingsDeviceInfo.textContent = isGpu ? `${data.device_name} (PyTorch ${data.torch_version})` : `PyTorch CPU mode (${data.torch_version})`;
        }
        if (this.dom.settingsAsrModel && Array.isArray(data.models)) {
          const savedModel = localStorage.getItem('transcript_asr_model');
          this.dom.settingsAsrModel.innerHTML = '';
          data.models.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m.id;
            const label = m.label || m.name || m.id;
            const sizeStr = m.size ? ` (${m.size})` : '';
            opt.textContent = `${label}${sizeStr}`;
            this.dom.settingsAsrModel.appendChild(opt);
          });
          if (savedModel && data.models.some((m) => m.id === savedModel)) {
            this.dom.settingsAsrModel.value = savedModel;
          } else if (data.default_model) {
            this.dom.settingsAsrModel.value = data.default_model;
          }
        }
      }
    } catch (err) {
      console.warn('Could not fetch ASR info:', err);
    }
  }

  openSettingsModal() {
    if (this.dom.settingsModal) this.dom.settingsModal.classList.remove('hidden');
  }

  closeSettingsModal() {
    if (this.dom.settingsModal) this.dom.settingsModal.classList.add('hidden');
  }

  // ---------------- Splitting & Deletion with No-Overlap ----------------

  splitUtterance() {
    const anno = this.currentUtterance;
    if (!anno) return;

    this.pushHistoryState('Split utterance');

    let splitTime = this.pendingSplitPoint || this.waveform.playheadSec;
    if (splitTime <= anno.start + 0.1 || splitTime >= anno.end - 0.1) {
      splitTime = (anno.start + anno.end) / 2;
    }

    const list = this.session.annotations[this.activeParticipant];
    const origEnd = anno.end;

    // First piece: anno.start to splitTime
    anno.end = roundTime(splitTime);

    // Second piece: splitTime to origEnd (strictly no overlap)
    const newAnno = {
      id: list.length + 1,
      start: roundTime(splitTime),
      end: roundTime(origEnd),
      text: ''
    };

    list.splice(this.currentIndex + 1, 0, newAnno);
    this.pendingSplitPoint = null;
    this.dom.btnSplitPause.textContent = `✂️ Split (${this.shortcuts.split.label})`;
    this.dom.btnSplitPause.style.borderColor = '';

    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(this.currentIndex);
    this.showToast('Split utterance into two without overlap');
  }

  deleteCurrentUtterance() {
    const list = this.session.annotations[this.activeParticipant] || [];
    if (this.currentIndex < 0 || this.currentIndex >= list.length) return;

    this.pushHistoryState('Delete utterance');

    list.splice(this.currentIndex, 1);
    this.renderUtteranceList();
    this.renderMultitrackOverview();

    if (this.currentIndex >= list.length) {
      this.currentIndex = list.length - 1;
    }
    if (this.currentIndex >= 0) {
      this.selectUtterance(this.currentIndex);
    } else {
      this.dom.transcriptInput.value = '';
    }
    this.showToast('Deleted utterance');
  }

  mergeWithNext() {
    const list = this.session?.annotations[this.activeParticipant] || [];
    if (this.currentIndex < 0 || this.currentIndex >= list.length - 1) {
      this.showToast('No subsequent utterance to merge with');
      return;
    }

    const currentAnno = list[this.currentIndex];
    const nextAnno = list[this.currentIndex + 1];

    this.pushHistoryState('Merge with next utterance');

    // Combine boundaries: from current.start to next.end
    currentAnno.end = Math.max(currentAnno.end, nextAnno.end);

    // Combine text cleanly with a single space
    const t1 = (currentAnno.text || '').trim();
    const t2 = (nextAnno.text || '').trim();
    if (t1 && t2) {
      currentAnno.text = `${t1} ${t2}`;
    } else {
      currentAnno.text = t1 || t2;
    }

    // Remove the next utterance
    list.splice(this.currentIndex + 1, 1);

    // Re-index remaining annotations sequentially
    list.forEach((a, idx) => {
      a.id = idx + 1;
    });

    this.dom.transcriptInput.value = currentAnno.text;
    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(this.currentIndex, true);
    this.markUnsaved();
    this.showToast(`🔗 Merged with next (new end: ${this.formatTime(currentAnno.end)})`);
  }

  onManualBoundsChange(start, end) {
    if (this.currentUtterance) {
      const list = this.session.annotations[this.activeParticipant];
      const prevAnno = this.currentIndex > 0 ? list[this.currentIndex - 1] : null;
      const nextAnno = this.currentIndex < list.length - 1 ? list[this.currentIndex + 1] : null;

      const minStart = prevAnno ? (prevAnno.end + 0.005) : 0.0;
      const maxEnd = nextAnno ? (nextAnno.start - 0.005) : this.waveform.duration;

      this.currentUtterance.start = roundTime(Math.max(minStart, start));
      this.currentUtterance.end = roundTime(Math.min(maxEnd, end));

      const dur = (this.currentUtterance.end - this.currentUtterance.start).toFixed(2);
      this.dom.currentAnnoTimes.textContent = `${this.formatTime(this.currentUtterance.start)} ➔ ${this.formatTime(this.currentUtterance.end)} (${dur}s)`;
      this.updateUtteranceInList(this.currentIndex);
      this.markUnsaved();
    }
  }

  // ---------------- Audio Playback & Mixing ----------------

  togglePlayPause() {
    if (this.isPlaying) {
      this.pauseAudio();
    } else {
      this.playUtterance();
    }
  }

  playUtterance() {
    const anno = this.currentUtterance;
    if (!anno) return;
    this.playRange(anno.start, anno.end);
  }

  replayUtterance() {
    const anno = this.currentUtterance;
    if (!anno) return;
    this.pauseAudio();
    this.playRange(anno.start, anno.end);
  }

  playRange(startSec, endSec) {
    const mainPlayer = this.audioPlayers[this.activeParticipant];
    if (!mainPlayer) return;

    this.isPlaying = true;
    this.playEndTime = endSec;
    this.dom.btnPlayPause.textContent = `⏸️ Pause (${this.shortcuts.playPause.label})`;

    Object.entries(this.audioPlayers).forEach(([pId, player]) => {
      player.currentTime = startSec;
      player.playbackRate = this.playbackRate;

      if (pId === this.activeParticipant) {
        player.volume = this.currentVolume;
        player.play().catch(e => console.log('Audio error:', e));
      } else {
        if (this.audioMode === 'ducking') {
          player.volume = 0.15 * this.currentVolume;
          player.play().catch(e => console.log('Audio error:', e));
        } else {
          player.pause();
        }
      }
    });

    if (this.playbackInterval) clearInterval(this.playbackInterval);
    this.playbackInterval = setInterval(() => {
      const curTime = mainPlayer.currentTime;
      this.waveform.setPlayhead(curTime);
      this.dom.currentTimeDisplay.textContent = this.formatTime(curTime);

      // Follow along if playhead reaches edge of window
      if (curTime > this.waveform.viewEnd - 0.1) {
        this.waveform.ensureTimeVisible(curTime, 0.05);
      }

      if (curTime >= this.playEndTime) {
        this.pauseAudio();
      }
    }, 25);
  }

  pauseAudio() {
    this.isPlaying = false;
    this.dom.btnPlayPause.textContent = `▶️ Play (${this.shortcuts.playPause.label})`;
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
    Object.values(this.audioPlayers).forEach((p) => p.pause());
  }

  seekAudio(timeSec, autoScroll = false) {
    const mainPlayer = this.audioPlayers[this.activeParticipant];
    if (mainPlayer) {
      mainPlayer.currentTime = timeSec;
      this.waveform.setPlayhead(timeSec, autoScroll);
      this.dom.currentTimeDisplay.textContent = this.formatTime(timeSec);
    }
  }

  seekBackward(sec = 2.0) {
    const mainPlayer = this.audioPlayers[this.activeParticipant];
    let curTime = this.waveform.playheadSec || 0.0;
    if (mainPlayer && !mainPlayer.paused) {
      curTime = mainPlayer.currentTime;
    }
    const newTime = Math.max(0, curTime - sec);
    this.seekAudio(newTime, true);
    this.waveform.ensureTimeVisible(newTime);
    this.showToast(`⏪ -${sec}s (${this.formatTime(newTime)})`);
  }

  seekForward(sec = 2.0) {
    const mainPlayer = this.audioPlayers[this.activeParticipant];
    let curTime = this.waveform.playheadSec || 0.0;
    if (mainPlayer && !mainPlayer.paused) {
      curTime = mainPlayer.currentTime;
    }
    const maxDur = (this.session && this.session.durations && this.session.durations[this.activeParticipant]) || this.waveform.duration || 999999;
    const newTime = Math.min(maxDur, curTime + sec);
    this.seekAudio(newTime, true);
    this.waveform.ensureTimeVisible(newTime);
    this.showToast(`+${sec}s ⏩ (${this.formatTime(newTime)})`);
  }

  setVolume(vol) {
    this.currentVolume = Math.max(0, Math.min(1.0, vol));
    localStorage.setItem('transcript_volume', this.currentVolume.toString());
    Object.entries(this.audioPlayers).forEach(([pId, p]) => {
      if (pId === this.activeParticipant) {
        p.volume = this.currentVolume;
      } else if (this.audioMode === 'ducking') {
        p.volume = 0.15 * this.currentVolume;
      }
    });
    if (this.dom.volumeSlider) this.dom.volumeSlider.value = this.currentVolume;
    if (this.dom.volumeIcon) {
      this.dom.volumeIcon.textContent = this.currentVolume === 0 ? '🔇' : (this.currentVolume < 0.5 ? '🔉' : '🔊');
    }
  }

  playAudioSlice(startSec, endSec) {
    const player = this.audioPlayers[this.activeParticipant];
    if (!player) return;
    Object.values(this.audioPlayers).forEach(p => p.pause());
    player.currentTime = startSec;
    player.volume = this.currentVolume;
    player.playbackRate = this.playbackRate;
    player.play().catch(() => {});
    this.playEndTime = endSec;

    if (this.playbackInterval) clearInterval(this.playbackInterval);
    this.playbackInterval = setInterval(() => {
      if (player.currentTime >= this.playEndTime || player.paused) {
        player.pause();
        clearInterval(this.playbackInterval);
        this.playbackInterval = null;
      }
    }, 25);
  }

  // ---------------- Missing Utterances Search ----------------

  openMissingUtterancesModal() {
    if (!this.session || !this.activeParticipant) {
      alert('Please load a session first.');
      return;
    }
    const srtName = (this.session.srt_filenames && this.session.srt_filenames[this.activeParticipant]) || `${this.activeParticipant}.srt`;
    if (this.dom.missingSpeakerLabel) {
      this.dom.missingSpeakerLabel.textContent = srtName;
    }
    if (this.dom.missingUtterancesModal) {
      this.dom.missingUtterancesModal.classList.remove('hidden');
    }

    // Retain previous scan results for the session if available
    if (this.missingScanCache && this.missingScanCache[this.activeParticipant]) {
      this.missingCandidates = this.missingScanCache[this.activeParticipant];
      if (this.dom.missingScanningIndicator) {
        this.dom.missingScanningIndicator.classList.add('hidden');
      }
      this.renderMissingCandidates();
    } else {
      this.rescanMissingUtterances(false);
    }
  }

  closeMissingUtterancesModal() {
    if (this.dom.missingUtterancesModal) {
      this.dom.missingUtterancesModal.classList.add('hidden');
    }
    if (this.dom.missingScanningIndicator) {
      this.dom.missingScanningIndicator.classList.add('hidden');
    }
    const player = this.audioPlayers[this.activeParticipant];
    if (player && !player.paused) {
      player.pause();
    }
  }

  setMissingFilter(filterName) {
    this.missingFilter = filterName;
    if (this.dom.filterMissingAll) this.dom.filterMissingAll.classList.toggle('active', filterName === 'all');
    if (this.dom.filterMissingSpeech) this.dom.filterMissingSpeech.classList.toggle('active', filterName === 'speech');
    if (this.dom.filterMissingBleed) this.dom.filterMissingBleed.classList.toggle('active', filterName === 'bleed');
    this.renderMissingCandidates();
  }

  async rescanMissingUtterances(force = false) {
    if (!this.session || !this.activeParticipant) return;
    if (this.dom.missingScanningIndicator) {
      this.dom.missingScanningIndicator.classList.remove('hidden');
    }
    if (this.dom.missingResultsContainer) {
      this.dom.missingResultsContainer.innerHTML = '';
    }
    if (this.dom.btnInsertAllMissing) {
      this.dom.btnInsertAllMissing.disabled = true;
    }

    try {
      const sensitivity = (this.dom.missingSensitivitySelect && this.dom.missingSensitivitySelect.value) || 'high_precision';
      const res = await fetch('/api/search_missing_utterances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          annotations: this.session.annotations[this.activeParticipant] || [],
          sensitivity: sensitivity
        })
      });
      const data = await res.json();
      if (data.success) {
        this.missingCandidates = data.candidates || [];
        this.missingScanCache[this.activeParticipant] = this.missingCandidates;
        this.renderMissingCandidates();
      } else {
        alert('Missing utterance detection failed: ' + (data.error || 'Server error'));
      }
    } catch (e) {
      console.error('Error scanning missing utterances:', e);
      alert('Network or server error while scanning gaps: ' + e.message);
    } finally {
      if (this.dom.missingScanningIndicator) {
        this.dom.missingScanningIndicator.classList.add('hidden');
      }
    }
  }

  renderMissingCandidates() {
    if (this.dom.missingScanningIndicator) {
      this.dom.missingScanningIndicator.classList.add('hidden');
    }
    const container = this.dom.missingResultsContainer;
    if (!container) return;
    container.innerHTML = '';

    const candidates = this.missingCandidates || [];
    const totalCount = candidates.length;
    const cleanCandidates = candidates.filter(c => !c.is_crosstalk);
    const cleanCount = cleanCandidates.length;
    const bleedCount = candidates.filter(c => c.is_crosstalk).length;

    // Update filter counts
    if (this.dom.filterMissingAll) this.dom.filterMissingAll.textContent = `All (${totalCount})`;
    if (this.dom.filterMissingSpeech) this.dom.filterMissingSpeech.textContent = `🎤 Likely Speech (${cleanCount})`;
    if (this.dom.filterMissingBleed) this.dom.filterMissingBleed.textContent = `⚠️ Bleed / Crosstalk (${bleedCount})`;

    if (totalCount === 0) {
      container.innerHTML = `
        <div class="missing-status-box">
          🎉 <strong>No unannotated speech activity detected!</strong><br>
          All audio activity across this channel is already captured by your current annotations.
        </div>`;
      if (this.dom.btnInsertAllMissing) this.dom.btnInsertAllMissing.disabled = true;
      return;
    }

    let filtered = candidates;
    if (this.missingFilter === 'speech') {
      filtered = candidates.filter(c => !c.is_crosstalk);
    } else if (this.missingFilter === 'bleed') {
      filtered = candidates.filter(c => c.is_crosstalk);
    }

    const pendingClean = cleanCandidates.filter(c => !c.inserted);
    if (this.dom.btnInsertAllMissing) {
      this.dom.btnInsertAllMissing.disabled = pendingClean.length === 0;
      this.dom.btnInsertAllMissing.textContent = `➕ Insert All Likely Speech (${pendingClean.length})`;
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="missing-status-box">
          No candidates in the <strong>${this.missingFilter === 'speech' ? 'Likely Speech' : 'Bleed'}</strong> category.
        </div>`;
      return;
    }

    filtered.forEach((cand, idx) => {
      const row = document.createElement('div');
      row.className = 'missing-candidate-row';

      const meta = document.createElement('div');
      meta.className = 'missing-candidate-meta';

      const indexBadge = document.createElement('span');
      indexBadge.className = 'missing-index-badge';
      indexBadge.textContent = `#${idx + 1}`;

      const timeBadge = document.createElement('span');
      timeBadge.className = 'missing-time-badge';
      timeBadge.textContent = `${this.formatTime(cand.start)} ➔ ${this.formatTime(cand.end)} (${cand.duration}s)`;

      const statusBadge = document.createElement('span');
      if (cand.is_crosstalk) {
        statusBadge.className = 'missing-crosstalk-badge bleed';
        statusBadge.textContent = `⚠️ Bleed from ${cand.dominant_speaker} (+${cand.energy_diff_db} dB)`;
        statusBadge.title = `Microphone ${cand.dominant_speaker} is significantly louder. Likely crosstalk bleed, not this speaker.`;
      } else {
        statusBadge.className = 'missing-crosstalk-badge clean';
        statusBadge.textContent = `🎤 Likely Speech (${cand.peak_db} dBFS)`;
        statusBadge.title = `Clear vocal energy on this speaker channel.`;
      }

      meta.appendChild(indexBadge);
      meta.appendChild(timeBadge);
      meta.appendChild(statusBadge);

      const actions = document.createElement('div');
      actions.className = 'missing-row-actions';

      const btnPlay = document.createElement('button');
      btnPlay.className = 'btn sm secondary';
      btnPlay.innerHTML = '▶️ Listen';
      btnPlay.title = 'Audition this audio slice';
      btnPlay.addEventListener('click', () => this.playAudioSlice(cand.start, cand.end));

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'missing-preview-input';
      input.placeholder = 'Utterance text...';
      if (cand.transcribedText) {
        input.value = cand.transcribedText;
      }
      input.addEventListener('input', (e) => {
        cand.transcribedText = e.target.value;
      });

      const btnTranscribe = document.createElement('button');
      btnTranscribe.className = 'btn sm highlight';
      btnTranscribe.innerHTML = '🎙️ Transcribe';
      btnTranscribe.title = 'Transcribe this audio slice';
      btnTranscribe.addEventListener('click', async () => {
        btnTranscribe.disabled = true;
        btnTranscribe.innerHTML = '⏳ ...';
        try {
          const selectedModel = (this.dom.settingsAsrModel ? this.dom.settingsAsrModel.value : null) || 'openai/whisper-tiny';
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              participant: this.activeParticipant,
              start: cand.start,
              end: cand.end,
              model: selectedModel
            })
          });
          const d = await res.json();
          if (d.success) {
            const txt = (d.text || '').trim();
            input.value = txt;
            cand.transcribedText = txt;
          }
        } catch (e) {
          console.warn('Transcribe preview error:', e);
        } finally {
          btnTranscribe.disabled = false;
          btnTranscribe.innerHTML = '🎙️ Transcribe';
        }
      });

      const btnGrammar = document.createElement('button');
      btnGrammar.className = 'btn sm secondary';
      btnGrammar.innerHTML = '✨ Grammar';
      btnGrammar.title = 'Correct grammar, casing, and punctuation';
      btnGrammar.addEventListener('click', async () => {
        const rawText = input.value.trim();
        if (!rawText) {
          this.showToast('Please transcribe or type text first', 'danger');
          return;
        }
        btnGrammar.disabled = true;
        btnGrammar.innerHTML = '⏳ ...';
        try {
          const res = await fetch('/api/correct_grammar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: rawText })
          });
          const gData = await res.json();
          if (gData.success && gData.corrected_text) {
            input.value = gData.corrected_text;
            cand.transcribedText = gData.corrected_text;
            this.showToast('✨ Grammar and casing corrected');
          }
        } catch (err) {
          console.warn('Grammar error:', err);
        } finally {
          btnGrammar.disabled = false;
          btnGrammar.innerHTML = '✨ Grammar';
        }
      });

      const btnInsert = document.createElement('button');
      btnInsert.className = 'btn sm primary';
      btnInsert.innerHTML = cand.inserted ? '✔ Added' : '➕ Insert';
      btnInsert.title = 'Insert into working .srt';
      if (cand.inserted) {
        btnInsert.disabled = true;
        row.style.opacity = '0.5';
      }
      btnInsert.addEventListener('click', () => {
        this.insertMissingCandidate(cand, input.value);
        btnInsert.disabled = true;
        btnInsert.innerHTML = '✔ Added';
        row.style.opacity = '0.5';
      });

      actions.appendChild(btnPlay);
      actions.appendChild(btnTranscribe);
      actions.appendChild(btnGrammar);
      actions.appendChild(input);
      actions.appendChild(btnInsert);

      row.appendChild(meta);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  insertMissingCandidate(cand, customText = '') {
    if (!this.session || !this.activeParticipant) return;
    const list = this.session.annotations[this.activeParticipant];
    if (!list) return;

    this.pushHistoryState('Insert missing utterance');

    const textToInsert = (customText || '').trim();
    const newAnno = {
      id: list.length + 1,
      start: roundTime(cand.start),
      end: roundTime(cand.end),
      text: textToInsert
    };

    list.push(newAnno);
    list.sort((a, b) => a.start - b.start);
    list.forEach((a, idx) => { a.id = idx + 1; });

    cand.inserted = true;
    cand.transcribedText = textToInsert;

    const newIndex = list.indexOf(newAnno);
    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.selectUtterance(newIndex, true);
    this.markUnsaved();
    this.showToast(`➕ Inserted missing utterance #${newIndex + 1} (${cand.start.toFixed(2)}s ➔ ${cand.end.toFixed(2)}s)`);

    // Update remaining insert all button label
    const cleanCandidates = (this.missingCandidates || []).filter(c => !c.is_crosstalk && !c.inserted);
    if (this.dom.btnInsertAllMissing) {
      this.dom.btnInsertAllMissing.disabled = cleanCandidates.length === 0;
      this.dom.btnInsertAllMissing.textContent = `➕ Insert All Likely Speech (${cleanCandidates.length})`;
    }
  }

  insertAllMissingCandidates() {
    if (!this.session || !this.activeParticipant) return;
    const list = this.session.annotations[this.activeParticipant];
    if (!list) return;

    const cleanCandidates = (this.missingCandidates || []).filter(c => !c.is_crosstalk && !c.inserted);
    if (cleanCandidates.length === 0) {
      this.showToast('No pending speech candidates to insert');
      return;
    }

    this.pushHistoryState('Bulk insert missing utterances');

    cleanCandidates.forEach(cand => {
      const newAnno = {
        id: list.length + 1,
        start: roundTime(cand.start),
        end: roundTime(cand.end),
        text: (cand.transcribedText || '').trim()
      };
      list.push(newAnno);
      cand.inserted = true;
    });

    list.sort((a, b) => a.start - b.start);
    list.forEach((a, idx) => { a.id = idx + 1; });

    this.renderUtteranceList();
    this.renderMultitrackOverview();
    this.markUnsaved();
    this.closeMissingUtterancesModal();
    this.showToast(`➕ Inserted ${cleanCandidates.length} missing utterances into ${this.activeParticipant}.srt`);
  }

  toggleAudioMode() {
    this.audioMode = this.audioMode === 'solo' ? 'ducking' : 'solo';
    this.dom.audioModeIcon.textContent = this.audioMode === 'solo' ? '🎧' : '👥';
    this.dom.audioModeText.textContent = this.audioMode === 'solo' ? 'Solo Mode (M)' : 'Context Ducking (M)';

    if (this.isPlaying) {
      Object.entries(this.audioPlayers).forEach(([pId, player]) => {
        if (pId !== this.activeParticipant) {
          player.volume = this.audioMode === 'ducking' ? 0.15 : 0.0;
          if (this.audioMode === 'ducking') player.play().catch(() => {});
          else player.pause();
        }
      });
    }
    this.showToast(`Audio: ${this.audioMode === 'solo' ? 'Solo Target' : 'Context Ducking (Others 15%)'}`);
  }

  updateAudioPlaybackRate() {
    Object.values(this.audioPlayers).forEach((p) => {
      p.playbackRate = this.playbackRate;
    });
  }

  // ---------------- Guideline Symbols Engine ----------------

  applyGuidelineTag(tag) {
    const textarea = this.dom.transcriptInput;
    const anno = this.currentUtterance;
    if (!anno) return;

    this.pushHistoryState(`Insert tag ${tag}`);

    let text = textarea.value;
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    const selectedText = text.substring(startPos, endPos);

    if (tag === '@') {
      textarea.value = '@';
    } else if (tag === '%') {
      textarea.value = '%';
    } else if (tag === '$') {
      textarea.value = '$';
    } else if (tag === '#') {
      textarea.value = text.substring(0, startPos) + '#' + text.substring(endPos);
    } else if (tag === '…') {
      textarea.value = text.substring(0, startPos) + '…' + text.substring(endPos);
    } else if (tag === '^') {
      const inner = selectedText || 'Ah';
      textarea.value = text.substring(0, startPos) + `^${inner}^` + text.substring(endPos);
    } else if (tag === '&') {
      const inner = selectedText || 'Hello!';
      textarea.value = text.substring(0, startPos) + `&${inner}&` + text.substring(endPos);
    } else if (tag === '-') {
      textarea.value = text.substring(0, startPos) + '-' + text.substring(endPos);
    } else if (tag === '~') {
      textarea.value = text.substring(0, startPos) + '~' + text.substring(endPos);
    }

    anno.text = textarea.value;
    this.updateUtteranceInList(this.currentIndex);
    this.markUnsaved();
    textarea.focus();
  }

  // ---------------- Shortcuts & Key Bindings ----------------

  loadShortcuts() {
    try {
      const version = localStorage.getItem('transcript_shortcuts_ver');
      if (version !== '3') {
        localStorage.setItem('transcript_shortcuts_ver', '3');
        localStorage.setItem('transcript_review_shortcuts', JSON.stringify(DEFAULT_SHORTCUTS));
        return { ...DEFAULT_SHORTCUTS };
      }
      const saved = localStorage.getItem('transcript_review_shortcuts');
      if (saved) {
        return { ...DEFAULT_SHORTCUTS, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.error('Error loading shortcuts:', e);
    }
    return { ...DEFAULT_SHORTCUTS };
  }

  saveShortcuts() {
    localStorage.setItem('transcript_review_shortcuts', JSON.stringify(this.shortcuts));
    this.updateShortcutBadges();
  }

  updateShortcutBadges() {
    document.querySelectorAll('.shortcut-label').forEach((el) => {
      const action = el.getAttribute('data-action');
      if (this.shortcuts[action]) {
        el.textContent = this.shortcuts[action].label;
      }
    });

    const legendPlay = document.getElementById('legendKeyPlay');
    if (legendPlay) legendPlay.textContent = this.shortcuts.playPause?.label || 'Tab';

    const legendNext = document.getElementById('legendKeyNext');
    if (legendNext) legendNext.textContent = this.shortcuts.next?.label || 'PageDown';

    const legendPrev = document.getElementById('legendKeyPrev');
    if (legendPrev) legendPrev.textContent = this.shortcuts.prev?.label || 'PageUp';

    const legendSnap = document.getElementById('legendKeySnap');
    if (legendSnap) legendSnap.textContent = this.shortcuts.snap?.label || 'Alt+Q';

    const legendSnapTrim = document.getElementById('legendKeySnapTrim');
    if (legendSnapTrim) legendSnapTrim.textContent = this.shortcuts.snapTrim?.label || 'Alt+W';

    const legendAdd = document.getElementById('legendKeyAdd');
    if (legendAdd) legendAdd.textContent = this.shortcuts.addUtterance?.label || 'Alt+A';

    const legendTranscribe = document.getElementById('legendKeyTranscribe');
    if (legendTranscribe) legendTranscribe.textContent = this.shortcuts.transcribe?.label || 'Alt+T';

    const legendGrammar = document.getElementById('legendKeyGrammar');
    if (legendGrammar) legendGrammar.textContent = this.shortcuts.grammar?.label || 'Alt+G';

    const legendSplit = document.getElementById('legendKeySplit');
    if (legendSplit) legendSplit.textContent = this.shortcuts.split?.label || 'Alt+S';

    const legendMergeNext = document.getElementById('legendKeyMergeNext');
    if (legendMergeNext) legendMergeNext.textContent = this.shortcuts.mergeNext?.label || 'Alt+M';

    const legendDelete = document.getElementById('legendKeyDelete');
    if (legendDelete) legendDelete.textContent = this.shortcuts.delete?.label || 'Alt+Delete';
  }

  matchesShortcut(e, actionName) {
    const s = this.shortcuts[actionName];
    if (!s) return false;

    const keyMatch = e.key.toLowerCase() === s.key.toLowerCase();
    const ctrlMatch = !!s.ctrl === (e.ctrlKey || e.metaKey);
    const altMatch = !!s.alt === e.altKey;
    const shiftMatch = !!s.shift === e.shiftKey;

    return keyMatch && ctrlMatch && altMatch && shiftMatch;
  }

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (this.recordingAction) {
        e.preventDefault();
        this.recordKeybinding(e);
        return;
      }

      if (document.activeElement === this.dom.filterInput ||
          document.activeElement === this.dom.sessionDirInput ||
          document.activeElement === this.dom.saveAsInput) {
        return;
      }

      const isTextarea = document.activeElement === this.dom.transcriptInput;

      // 1a. Enter key when NOT typing in textarea -> Focus textarea to edit
      if (!isTextarea && e.key === 'Enter') {
        e.preventDefault();
        this.dom.transcriptInput.focus();
        const len = this.dom.transcriptInput.value.length;
        this.dom.transcriptInput.setSelectionRange(len, len);
        return;
      }

      // 1b. Enter key inside textarea -> Move to next annotation
      if (isTextarea && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.nextUtterance();
        return;
      }

      // 2. Play / Pause (Default: Tab)
      if (this.matchesShortcut(e, 'playPause')) {
        e.preventDefault();
        this.togglePlayPause();
        return;
      }

      // 3. Repeat (Default: Shift+Tab)
      if (this.matchesShortcut(e, 'replay')) {
        e.preventDefault();
        this.replayUtterance();
        return;
      }

      // 4. Next Utterance (Default: PageDown)
      if (this.matchesShortcut(e, 'next')) {
        e.preventDefault();
        this.nextUtterance();
        return;
      }

      // 5. Previous Utterance (Default: PageUp)
      if (this.matchesShortcut(e, 'prev')) {
        e.preventDefault();
        this.prevUtterance();
        return;
      }

      // 6. Undo / Redo
      if (this.matchesShortcut(e, 'undo')) {
        e.preventDefault();
        this.undo();
        return;
      }
      if (this.matchesShortcut(e, 'redo')) {
        e.preventDefault();
        this.redo();
        return;
      }

      // 7. Save Active: Ctrl+S
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveActiveParticipant();
        return;
      }

      // 8. Guideline Symbol Alt-Shortcuts
      if (this.matchesShortcut(e, 'tagBackchannel')) { e.preventDefault(); this.applyGuidelineTag('@'); return; }
      if (this.matchesShortcut(e, 'tagLaugh')) { e.preventDefault(); this.applyGuidelineTag('%'); return; }
      if (this.matchesShortcut(e, 'tagNoise')) { e.preventDefault(); this.applyGuidelineTag('$'); return; }
      if (this.matchesShortcut(e, 'tagWordDisfluency')) { e.preventDefault(); this.applyGuidelineTag('#'); return; }
      if (this.matchesShortcut(e, 'tagDiscontinuity')) { e.preventDefault(); this.applyGuidelineTag('…'); return; }
      if (this.matchesShortcut(e, 'tagInterjection')) { e.preventDefault(); this.applyGuidelineTag('^'); return; }
      if (this.matchesShortcut(e, 'tagNonEnglish')) { e.preventDefault(); this.applyGuidelineTag('&'); return; }
      if (this.matchesShortcut(e, 'tagStutter')) { e.preventDefault(); this.applyGuidelineTag('-'); return; }
      if (this.matchesShortcut(e, 'tagUnclear')) { e.preventDefault(); this.applyGuidelineTag('~'); return; }

      // 9. Actions (snap, add, transcribe, split, delete, audioMode):
      // Allowed if NOT in textarea, OR if inside textarea and the shortcut uses a modifier (Alt, Ctrl)
      // or a special non-character key (Function keys F1-F12, Delete, Insert) so normal typing isn't interrupted.
      const isActionAllowedInFocus = (action) => {
        if (!isTextarea) return true;
        const s = this.shortcuts[action];
        if (!s) return false;
        if (s.alt || s.ctrl) return true;
        const k = s.key;
        if (k === 'Delete' || k === 'Insert' || k === 'Tab' || k === 'PageUp' || k === 'PageDown') return true;
        if (/^F\d+$/i.test(k)) return true;
        return false;
      };

      if (isActionAllowedInFocus('delete') && this.matchesShortcut(e, 'delete')) {
        e.preventDefault();
        e.stopPropagation();
        this.deleteCurrentUtterance();
        return;
      }
      if (isActionAllowedInFocus('snap') && this.matchesShortcut(e, 'snap')) {
        e.preventDefault();
        e.stopPropagation();
        this.snapToWave('expand');
        return;
      }
      if (isActionAllowedInFocus('snapTrim') && this.matchesShortcut(e, 'snapTrim')) {
        e.preventDefault();
        e.stopPropagation();
        this.snapToWave('trim');
        return;
      }
      if (isActionAllowedInFocus('addUtterance') && this.matchesShortcut(e, 'addUtterance')) {
        e.preventDefault();
        e.stopPropagation();
        this.addUtterance();
        return;
      }
      if (isActionAllowedInFocus('transcribe') && this.matchesShortcut(e, 'transcribe')) {
        e.preventDefault();
        e.stopPropagation();
        this.autoTranscribeActive();
        return;
      }
      if (isActionAllowedInFocus('grammar') && this.matchesShortcut(e, 'grammar')) {
        e.preventDefault();
        e.stopPropagation();
        this.correctGrammar();
        return;
      }
      if (isActionAllowedInFocus('split') && this.matchesShortcut(e, 'split')) {
        e.preventDefault();
        e.stopPropagation();
        this.splitUtterance();
        return;
      }
      if (isActionAllowedInFocus('mergeNext') && this.matchesShortcut(e, 'mergeNext')) {
        e.preventDefault();
        e.stopPropagation();
        this.mergeWithNext();
        return;
      }

      // Shift + ArrowLeft / ArrowRight media seek (2 seconds)
      if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        if (!isTextarea) {
          e.preventDefault();
          if (e.key === 'ArrowRight') this.seekForward(2.0);
          else this.seekBackward(2.0);
          return;
        }
      }

      // Configurable seek shortcuts
      if (isActionAllowedInFocus('seekForward') && this.matchesShortcut(e, 'seekForward')) {
        e.preventDefault();
        e.stopPropagation();
        this.seekForward(2.0);
        return;
      }
      if (isActionAllowedInFocus('seekBackward') && this.matchesShortcut(e, 'seekBackward')) {
        e.preventDefault();
        e.stopPropagation();
        this.seekBackward(2.0);
        return;
      }

      if (isActionAllowedInFocus('audioMode') && this.matchesShortcut(e, 'audioMode')) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleAudioMode();
        return;
      }
      if (!isTextarea && e.key >= '1' && e.key <= '4') {
        const idx = parseInt(e.key) - 1;
        if (this.session && this.session.participants[idx]) {
          e.preventDefault();
          this.selectParticipant(this.session.participants[idx]);
          return;
        }
      }
    });
  }

  // ---------------- Shortcuts Customization Modal ----------------

  openShortcutsModal() {
    this.dom.shortcutsGrid.innerHTML = '';
    const actionLabels = {
      playPause: 'Play / Pause',
      next: 'Next Utterance',
      prev: 'Previous Utterance',
      snap: 'Enlarge to Wave (Expand Outward)',
      snapTrim: 'Snap to Wave Trim (Tighten Inward)',
      addUtterance: 'Add Utterance',
      transcribe: 'Auto-Transcribe Active',
      grammar: 'Correct Grammar & Casing',
      split: 'Split Utterance',
      mergeNext: 'Merge with Next Utterance',
      seekForward: 'Move Forward (2s)',
      seekBackward: 'Move Backward (2s)',
      delete: 'Delete Utterance',
      audioMode: 'Solo / Duck Audio',
      undo: 'Undo Action',
      redo: 'Redo Action',
      tagBackchannel: 'Insert [@] Backchannel',
      tagLaugh: 'Insert [%] Laugh',
      tagNoise: 'Insert [$] Vocal Noise',
      tagWordDisfluency: 'Insert [#] Word Cut-off',
      tagDiscontinuity: 'Insert […] Discontinuity',
      tagInterjection: 'Wrap [^] Interjection',
      tagNonEnglish: 'Wrap [&] Non-English',
      tagStutter: 'Insert [-] Stutter Hyphen',
      tagUnclear: 'Insert [~] Unclear Token'
    };

    Object.entries(this.shortcuts).forEach(([action, config]) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const nameCol = document.createElement('div');
      nameCol.style.display = 'flex';
      nameCol.style.flexDirection = 'column';
      nameCol.style.gap = '2px';

      const name = document.createElement('span');
      name.className = 'shortcut-name';
      name.textContent = actionLabels[action] || action;
      nameCol.appendChild(name);

      const canRunInText = config.alt || config.ctrl || config.key === 'Delete' || config.key === 'Insert' || /^F\d+$/i.test(config.key);
      const isAltDConflict = config.alt && !config.ctrl && !config.shift && config.key.toLowerCase() === 'd';
      const isCtrlWConflict = config.ctrl && !config.alt && config.key.toLowerCase() === 'w';

      const badge = document.createElement('span');
      badge.style.fontSize = '11px';
      if (isCtrlWConflict) {
        badge.style.color = '#f87171';
        badge.textContent = '⛔ Browser reserved (closes tab)';
      } else if (isAltDConflict) {
        badge.style.color = '#fbbf24';
        badge.textContent = '⚠️ Conflicts with address bar (use Alt+Shift+D)';
      } else if (canRunInText) {
        badge.style.color = '#34d399';
        badge.textContent = '✓ Works while typing';
      } else {
        badge.style.color = 'var(--text-secondary, #94a3b8)';
        badge.textContent = 'Works in navigation mode';
      }
      nameCol.appendChild(badge);

      const btn = document.createElement('div');
      btn.className = 'key-input-box';
      btn.textContent = config.label;
      btn.setAttribute('data-action', action);

      btn.addEventListener('click', () => {
        document.querySelectorAll('.key-input-box').forEach(b => b.classList.remove('recording'));
        btn.classList.add('recording');
        btn.textContent = 'Press key...';
        this.recordingAction = action;
      });

      row.appendChild(nameCol);
      row.appendChild(btn);
      this.dom.shortcutsGrid.appendChild(row);
    });

    this.dom.shortcutsModal.classList.remove('hidden');
  }

  applyPresetWorksWhileTyping() {
    this.shortcuts = { ...BROWSER_SAFE_PRESET };
    this.saveShortcuts();
    this.openShortcutsModal();
    this.showToast('Applied "Works While Typing" preset (Alt+Shift shortcuts)');
  }

  closeShortcutsModal() {
    this.recordingAction = null;
    this.dom.shortcutsModal.classList.add('hidden');
    this.saveShortcuts();
  }

  recordKeybinding(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    let labelParts = [];
    if (e.ctrlKey || e.metaKey) labelParts.push('Ctrl');
    if (e.altKey) labelParts.push('Alt');
    if (e.shiftKey) labelParts.push('Shift');

    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    labelParts.push(keyName.length === 1 ? keyName.toUpperCase() : keyName);

    const newLabel = labelParts.join('+');

    this.shortcuts[this.recordingAction] = {
      key: e.key,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      label: newLabel
    };

    const targetBtn = document.querySelector(`.key-input-box[data-action="${this.recordingAction}"]`);
    if (targetBtn) {
      targetBtn.textContent = newLabel;
      targetBtn.classList.remove('recording');
    }

    this.recordingAction = null;
  }

  resetShortcuts() {
    if (confirm('Reset all keyboard shortcuts to defaults?')) {
      this.shortcuts = { ...DEFAULT_SHORTCUTS };
      this.saveShortcuts();
      this.openShortcutsModal();
      this.showToast('Reset shortcuts to default');
    }
  }

  // ---------------- Navigation ----------------

  prevUtterance() {
    if (this.currentIndex > 0) {
      this.selectUtterance(this.currentIndex - 1);
    }
  }

  nextUtterance() {
    const list = this.session?.annotations[this.activeParticipant] || [];
    if (this.currentIndex < list.length - 1) {
      this.selectUtterance(this.currentIndex + 1);
    }
  }

  // ---------------- UI Rendering ----------------

  renderUtteranceList() {
    const list = this.session?.annotations[this.activeParticipant] || [];
    const filter = this.dom.filterInput.value.toLowerCase().trim();

    this.dom.utteranceList.innerHTML = '';
    let visibleCount = 0;

    list.forEach((anno, idx) => {
      const textMatches = !filter || anno.text.toLowerCase().includes(filter);
      if (!textMatches) return;
      visibleCount++;

      const item = document.createElement('div');
      item.className = `utterance-item ${idx === this.currentIndex ? 'active' : ''}`;
      item.setAttribute('data-index', idx);

      const header = document.createElement('div');
      header.className = 'utterance-item-header';
      header.innerHTML = `<span>#${idx + 1}</span> <span>${this.formatTime(anno.start)}</span>`;

      const textEl = document.createElement('div');
      textEl.className = 'utterance-item-text';
      textEl.textContent = anno.text || '∅ (empty)';

      item.appendChild(header);
      item.appendChild(textEl);

      item.addEventListener('click', () => this.selectUtterance(idx));
      this.dom.utteranceList.appendChild(item);
    });

    this.dom.listStats.textContent = `${visibleCount} of ${list.length} utterances`;
  }

  updateUtteranceInList(index) {
    const el = document.querySelector(`.utterance-item[data-index="${index}"] .utterance-item-text`);
    if (el && this.currentUtterance) {
      el.textContent = this.currentUtterance.text || '∅ (empty)';
    }
  }

  renderMultitrackOverview() {
    if (!this.session) return;
    this.dom.overviewTracks.innerHTML = '';

    const maxDuration = Math.max(...Object.values(this.session.durations || { default: 1 }));

    this.session.participants.forEach((pId) => {
      const row = document.createElement('div');
      row.className = 'track-row';

      const label = document.createElement('span');
      label.className = 'track-name';
      label.textContent = pId;

      const barContainer = document.createElement('div');
      barContainer.className = 'track-bar-container';

      const annos = this.session.annotations[pId] || [];
      annos.forEach((a) => {
        const leftPct = (a.start / maxDuration) * 100;
        const widthPct = Math.max(0.2, ((a.end - a.start) / maxDuration) * 100);

        const block = document.createElement('div');
        block.className = `track-block ${pId === this.activeParticipant ? 'active-participant' : ''}`;
        block.style.left = `${leftPct}%`;
        block.style.width = `${widthPct}%`;
        barContainer.appendChild(block);
      });

      row.appendChild(label);
      row.appendChild(barContainer);
      this.dom.overviewTracks.appendChild(row);
    });
  }

  // ---------------- Save Implementations with Timestamped Backups ----------------

  async saveActiveParticipant() {
    if (!this.session || !this.activeParticipant) return;
    if (this.currentUtterance && this.dom.transcriptInput) {
      this.currentUtterance.text = this.dom.transcriptInput.value;
      this.updateUtteranceInList(this.currentIndex);
    }
    const annos = this.session.annotations[this.activeParticipant] || [];
    const activeSrtName = (this.session && this.session.srt_filenames && this.session.srt_filenames[this.activeParticipant]) || `${this.activeParticipant}.srt`;

    try {
      this.dom.btnSaveActive.textContent = '💾 Saving...';
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          srt_filename: activeSrtName,
          annotations: annos
        })
      });
      const data = await res.json();
      if (data.success) {
        if (data.filename) {
          this.session.srt_filenames[this.activeParticipant] = data.filename;
          this.renderParticipantTabs();
        }
        this.markSaved();
        this.showToast(`✓ Saved ${data.filename} (Backup saved in .backups/)`);
      } else {
        alert('Save error: ' + data.error);
      }
    } catch (e) {
      alert('Network error saving file: ' + e.message);
    } finally {
      const finalName = (this.session && this.session.srt_filenames && this.session.srt_filenames[this.activeParticipant]) || `${this.activeParticipant}.srt`;
      this.dom.btnSaveActive.innerHTML = `💾 Save <span id="saveActiveTargetLabel">${finalName} (Ctrl+S)</span>`;
      this.dom.saveActiveTargetLabel = document.getElementById('saveActiveTargetLabel');
    }
  }

  async saveAllParticipants() {
    if (!this.session) return;
    if (this.currentUtterance && this.dom.transcriptInput) {
      this.currentUtterance.text = this.dom.transcriptInput.value;
      this.updateUtteranceInList(this.currentIndex);
    }
    try {
      this.dom.btnSaveAll.textContent = '💾 Saving All...';
      const res = await fetch('/api/save_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          all_annotations: this.session.annotations
        })
      });
      const data = await res.json();
      if (data.success) {
        this.markSaved();
        this.showToast(`✓ Successfully saved all ${data.saved_count} participant SRT files (${data.saved_files.join(', ')})`);
      } else {
        alert('Save all error: ' + data.error);
      }
    } catch (e) {
      alert('Network error saving all files: ' + e.message);
    } finally {
      this.dom.btnSaveAll.textContent = '💾 Save All';
    }
  }

  openSaveAsModal() {
    if (!this.session || !this.activeParticipant) return;
    const currentName = (this.session && this.session.srt_filenames && this.session.srt_filenames[this.activeParticipant]) || `${this.activeParticipant}.srt`;
    const base = currentName.replace(/\.srt$/i, '');
    this.dom.saveAsParticipantLabel.textContent = currentName;
    this.dom.saveAsInput.value = base.endsWith('_cleaned') ? `${base}.srt` : `${base}_cleaned.srt`;
    this.dom.saveAsModal.classList.remove('hidden');
    this.dom.saveAsInput.focus();
  }

  closeSaveAsModal() {
    this.dom.saveAsModal.classList.add('hidden');
  }

  async confirmSaveAs() {
    const customPath = this.dom.saveAsInput.value.trim();
    if (!customPath) {
      alert('Please enter a target filename or path.');
      return;
    }

    if (this.currentUtterance && this.dom.transcriptInput) {
      this.currentUtterance.text = this.dom.transcriptInput.value;
      this.updateUtteranceInList(this.currentIndex);
    }
    const annos = this.session.annotations[this.activeParticipant] || [];

    try {
      this.dom.btnConfirmSaveAs.textContent = 'Saving...';
      const res = await fetch('/api/save_as', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant: this.activeParticipant,
          output_path: customPath,
          annotations: annos
        })
      });
      const data = await res.json();
      if (data.success) {
        // Crucially update active file for this participant to the newly saved target
        if (data.filename) {
          this.session.srt_filenames[this.activeParticipant] = data.filename;
          this.renderParticipantTabs();
          if (this.dom.saveActiveTargetLabel) {
            this.dom.saveActiveTargetLabel.textContent = `${data.filename} (Ctrl+S)`;
          }
        }
        this.closeSaveAsModal();
        this.markSaved();
        this.showToast(`✓ Saved & switched active file to: ${data.filename}`);
      } else {
        alert('Save As error: ' + data.error);
      }
    } catch (e) {
      alert('Error during Save As: ' + e.message);
    } finally {
      this.dom.btnConfirmSaveAs.textContent = 'Save Copy';
    }
  }

  async exportEaf() {
    if (!this.session) return;
    try {
      this.dom.btnExportEaf.textContent = 'Exporting...';
      const res = await fetch('/api/export_eaf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'reviewed_session.eaf' })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`📑 Exported ELAN document to reviewed_session.eaf`);
      } else {
        alert('Export error: ' + data.error);
      }
    } catch (e) {
      alert('Error exporting EAF: ' + e.message);
    } finally {
      this.dom.btnExportEaf.textContent = '📑 Export ELAN (.eaf)';
    }
  }

  // ---------------- Toast Notifications ----------------

  showToast(message, type = 'success', duration = 3500) {
    const toast = this.dom.toastNotification;
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');

    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, duration);
  }

  formatTime(sec) {
    if (isNaN(sec) || sec < 0) sec = 0;
    const mins = Math.floor(sec / 60);
    const secs = (sec % 60).toFixed(3);
    return `${mins.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
  }
}

function roundTime(sec) {
  return Math.round(sec * 1000) / 1000;
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new TranscriptApp();
});
