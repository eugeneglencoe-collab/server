// remotion/index.js
const { registerRoot, Composition } = require('remotion');
const { AutoTubeVideo } = require('./VideoComposition');

registerRoot(() => {
  return (
    <>
      <Composition
        id="AutoTubeVideo"
        component={AutoTubeVideo}
        durationInFrames={300} // Override dynamiquement via inputProps
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          audioUrl: '',
          imageUrls: [],
          script: '',
          title: 'AutoTube',
          durationSec: 10,
          fps: 30,
        }}
        calculateMetadata={async ({ props }) => ({
          durationInFrames: (props.durationSec || 10) * (props.fps || 30),
          fps: props.fps || 30,
        })}
      />
    </>
  );
});
