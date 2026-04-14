// remotion/VideoComposition.jsx
// Composition principale : images + voix + sous-titres

const { AbsoluteFill, Audio, Img, Sequence, useCurrentFrame, useVideoConfig, interpolate } = require('remotion');

const { fps: _fps } = useVideoConfig ? {} : {};

function Slide({ imageUrl, startFrame, durationFrames }) {
  const frame = useCurrentFrame();
  const relFrame = frame - startFrame;

  // Légère animation Ken Burns
  const scale = interpolate(relFrame, [0, durationFrames], [1, 1.08], {
    extrapolateRight: 'clamp',
  });
  const opacity = interpolate(relFrame, [0, 15, durationFrames - 15, durationFrames], [0, 1, 1, 0], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });

  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img
        src={imageUrl}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale})`,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
}

function Subtitle({ lines, fps }) {
  const frame = useCurrentFrame();

  // Trouver la ligne active
  const currentLine = lines.find(l =>
    frame >= l.startFrame && frame < l.endFrame
  );

  if (!currentLine) return null;

  const progress = (frame - currentLine.startFrame) / (currentLine.endFrame - currentLine.startFrame);
  const opacity = interpolate(progress, [0, 0.1, 0.85, 1], [0, 1, 1, 0]);

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 60px 80px' }}>
      <div style={{
        background: 'rgba(0,0,0,0.75)',
        borderRadius: 10,
        padding: '12px 24px',
        maxWidth: 800,
        textAlign: 'center',
        opacity,
      }}>
        <span style={{
          color: '#ffffff',
          fontSize: 32,
          fontFamily: 'sans-serif',
          fontWeight: 600,
          lineHeight: 1.4,
          textShadow: '0 2px 8px rgba(0,0,0,0.8)',
        }}>
          {currentLine.text}
        </span>
      </div>
    </AbsoluteFill>
  );
}

// Découpe le script en lignes de sous-titres
function buildSubtitleLines(script, totalFrames, fps) {
  if (!script) return [];
  const words = script.split(' ').filter(Boolean);
  const chunkSize = 8; // mots par sous-titre
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  const framePer = Math.floor(totalFrames / chunks.length);
  return chunks.map((text, i) => ({
    text,
    startFrame: i * framePer,
    endFrame: (i + 1) * framePer,
  }));
}

function AutoTubeVideo({ audioUrl, imageUrls, script, title, durationSec, fps = 30 }) {
  const totalFrames = durationSec * fps;
  const framesPerImage = Math.floor(totalFrames / imageUrls.length);
  const subtitleLines = buildSubtitleLines(script, totalFrames, fps);

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {/* Images en séquence */}
      {imageUrls.map((url, i) => (
        <Sequence
          key={i}
          from={i * framesPerImage}
          durationInFrames={i === imageUrls.length - 1
            ? totalFrames - i * framesPerImage
            : framesPerImage}
        >
          <Slide
            imageUrl={url}
            startFrame={i * framesPerImage}
            durationFrames={framesPerImage}
          />
        </Sequence>
      ))}

      {/* Voix off */}
      {audioUrl && <Audio src={audioUrl} />}

      {/* Sous-titres */}
      <Subtitle lines={subtitleLines} fps={fps} />

      {/* Titre (premières 3 secondes) */}
      {title && (
        <Sequence from={0} durationInFrames={fps * 3}>
          <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
            <div style={{
              background: 'rgba(0,0,0,0.6)',
              borderRadius: 16,
              padding: '20px 40px',
              textAlign: 'center',
            }}>
              <span style={{
                color: '#00ff88',
                fontSize: 48,
                fontFamily: 'sans-serif',
                fontWeight: 800,
                textShadow: '0 4px 16px rgba(0,255,136,0.4)',
              }}>
                {title}
              </span>
            </div>
          </AbsoluteFill>
        </Sequence>
      )}
    </AbsoluteFill>
  );
}

module.exports = { AutoTubeVideo };
