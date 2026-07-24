import React, { useState } from 'react';
import DrawCanvas from './DrawCanvas';
import AudioRecorder from './AudioRecorder';
import { compressImageToDataUrl } from '../utils/compressImage';
import { getTextSubmitMode } from '../utils/answerSettings';
import { useTranslation } from '../i18n/LanguageContext';

// A text-field answer composer: type text, paste/draw an image, or record an
// audio clip, then submit. The three sources are mutually exclusive — the
// submitted value is a plain string (text, an image data URL or an audio data
// URL) so the rest of the answer flow treats them identically. Shared by the
// text-answer question type and the crocodile performer's response input.

// Keep pasted/drawn images well under the server's answer-size limit (8M chars,
// isValidAnswerValue in backend websocket.js). The byte budget maps to the
// data-URL length the server sees: chars ≈ bytes * 4/3 + prefix.
const MAX_ANSWER_IMAGE_CHARS = 2000000;
const MAX_ANSWER_IMAGE_BYTES = Math.floor((MAX_ANSWER_IMAGE_CHARS - 100) * 3 / 4);

const AnswerComposer = ({
  onSubmit,
  onPreviewImage,
  submitLabel,
  buttonStyle = {},
  drawStreamQuestionId = null,
  clearAfterSubmit = false,
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [image, setImage] = useState(null);
  const [audio, setAudio] = useState(null);
  const [drawOpen, setDrawOpen] = useState(false);

  const value = image || audio || text.trim();
  const canSubmit = !!value;

  const handlePaste = async (e) => {
    const item = Array.from(e.clipboardData?.items || [])
      .find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    try {
      const { dataUrl } = await compressImageToDataUrl(file, MAX_ANSWER_IMAGE_BYTES);
      setImage(dataUrl);
    } catch (error) {
      console.warn('Could not process pasted image:', error);
    }
  };

  // The drawing pad hands back a PNG data URL; run it through the same
  // size-budget compression as a pasted image.
  const handleApplyDrawing = async (dataUrl) => {
    setDrawOpen(false);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const { dataUrl: compressed } = await compressImageToDataUrl(blob, MAX_ANSWER_IMAGE_BYTES);
      setImage(compressed);
    } catch (error) {
      console.warn('Could not process drawing:', error);
      setImage(dataUrl);
    }
  };

  const submit = () => {
    if (canSubmit) {
      onSubmit(value);
      if (clearAfterSubmit) {
        setText('');
        setImage(null);
        setAudio(null);
      }
    }
  };

  const removeButton = (onRemove) => (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t('common.close')}
      style={{
        position: 'absolute',
        top: '-10px',
        right: '-10px',
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        background: '#ef4444',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        fontWeight: 'bold'
      }}
    >
      ×
    </button>
  );

  return (
    <div className="answer-composer" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', alignItems: 'center' }}>
      {image ? (
        <div style={{ position: 'relative' }}>
          <img
            src={image}
            alt="answer"
            title={onPreviewImage ? t('question.clickToEnlarge') : undefined}
            onClick={onPreviewImage ? () => onPreviewImage(image) : undefined}
            style={{ maxWidth: '300px', maxHeight: '200px', borderRadius: '8px', cursor: onPreviewImage ? 'zoom-in' : 'default' }}
          />
          {removeButton(() => setImage(null))}
        </div>
      ) : audio ? (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <audio controls src={audio} style={{ maxWidth: '320px' }} />
          {removeButton(() => setAudio(null))}
        </div>
      ) : (
        <textarea
          className="answer-composer__textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const mode = getTextSubmitMode();
            const sendOnPlainEnter = mode === 'enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey;
            const sendOnCtrlEnter = mode === 'ctrl-enter' && (e.ctrlKey || e.metaKey);
            if (sendOnPlainEnter || sendOnCtrlEnter) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('question.textPlaceholder')}
          rows={3}
          style={{
            width: '100%',
            maxWidth: '600px',
            fontSize: '1.1rem',
            padding: '0.75rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--glass-border)',
            background: 'var(--input-bg)',
            color: 'var(--text-primary)',
            resize: 'vertical',
            fontFamily: 'inherit'
          }}
        />
      )}

      <div className="answer-composer__actions">
        {/* Image and audio are alternative inputs; hide one once the other is set */}
        <div className="answer-composer__tools">
          {!audio && (
            <button
              type="button"
              className="answer-composer__tool-button"
              onClick={() => setDrawOpen(true)}
              style={{
                ...buttonStyle,
                background: 'var(--input-bg)',
                color: 'var(--text-primary)',
                border: '1px solid var(--glass-border)'
              }}
            >
              🖌 {image ? t('question.editDrawing') : t('question.drawAnswer')}
            </button>
          )}
          {!image && !audio && (
            <AudioRecorder onRecorded={setAudio} buttonStyle={buttonStyle} />
          )}
        </div>

        <button
          type="button"
          onClick={submit}
          className="btn-primary answer-composer__submit"
          style={{ ...buttonStyle, opacity: canSubmit ? 1 : 0.5 }}
          disabled={!canSubmit}
        >
          {submitLabel}
        </button>
      </div>

      <DrawCanvas
        open={drawOpen}
        onClose={() => setDrawOpen(false)}
        onApply={handleApplyDrawing}
        initialImage={typeof image === 'string' && image.startsWith('data:image') ? image : null}
        streamQuestionId={drawStreamQuestionId}
      />
    </div>
  );
};

export default AnswerComposer;
