type AutomaticSpeechRecognitionResult = {
  text?: string;
};

type AutomaticSpeechRecognitionPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionResult>;

export function getLocalSpeechTranscriptionOptions(): Record<string, unknown> {
  return {
    chunk_length_s: 20,
    stride_length_s: 4,
    task: "transcribe",
    language: "zh",
  };
}

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null =
  null;

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    transcriberPromise = import("@xenova/transformers")
      .then(async ({ env, pipeline }) => {
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        return pipeline(
          "automatic-speech-recognition",
          "Xenova/whisper-tiny",
        ) as Promise<AutomaticSpeechRecognitionPipeline>;
      })
      .catch((error) => {
        transcriberPromise = null;
        throw error;
      });
  }

  return transcriberPromise;
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length);
  for (
    let channelIndex = 0;
    channelIndex < buffer.numberOfChannels;
    channelIndex += 1
  ) {
    const channel = buffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
      output[sampleIndex] += channel[sampleIndex] / buffer.numberOfChannels;
    }
  }

  return output;
}

async function resampleTo16k(
  audio: Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  if (sampleRate === 16000) {
    return audio;
  }

  const source = new AudioBuffer({
    length: audio.length,
    numberOfChannels: 1,
    sampleRate,
  });
  source.getChannelData(0).set(audio);

  const offlineContext = new OfflineAudioContext(
    1,
    Math.ceil((audio.length * 16000) / sampleRate),
    16000,
  );
  const node = offlineContext.createBufferSource();
  node.buffer = source;
  node.connect(offlineContext.destination);
  node.start(0);

  const rendered = await offlineContext.startRendering();
  return rendered.getChannelData(0).slice();
}

async function decodeBlob(
  blob: Blob,
): Promise<{ audio: Float32Array; sampleRate: number }> {
  const context = new AudioContext();

  try {
    const data = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(data.slice(0));
    return {
      audio: mixToMono(decoded),
      sampleRate: decoded.sampleRate,
    };
  } finally {
    await context.close();
  }
}

export async function transcribeAudioBlob(blob: Blob): Promise<string> {
  const { audio, sampleRate } = await decodeBlob(blob);
  const mono16k = await resampleTo16k(audio, sampleRate);
  const transcriber = await getTranscriber();
  const result = await transcriber(
    mono16k,
    getLocalSpeechTranscriptionOptions(),
  );

  return result.text?.trim() ?? "";
}
