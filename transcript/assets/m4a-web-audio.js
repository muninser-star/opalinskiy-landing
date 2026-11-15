const sampleRate = 16_000;
const blockFrames = 16_384;

export function createM4aPartEncoder({
  AudioSample, AudioSampleSource, BufferTarget, Conversion, Mp4OutputFormat, Mp3OutputFormat, Output,
}) {
  return async function encodeM4aPart(input, start, end) {
    // Remux only the current part so Web Audio never decodes the entire recording into memory.
    const context = new OfflineAudioContext(1, 1, sampleRate);
    const compressed = new BufferTarget();
    const remux = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat(), target: compressed }),
      tracks: 'primary',
      video: { discard: true },
      audio: { codec: 'aac' },
      trim: { start, end },
      copy: { mode: 'forced' },
      tags: () => ({}),
      showWarnings: false,
    });
    if (!remux.isValid) throw new Error('Could not extract an AAC audio part.');
    await remux.execute();
    const decoded = await context.decodeAudioData(compressed.buffer);

    const mp3 = new BufferTarget();
    const output = new Output({ format: new Mp3OutputFormat(), target: mp3 });
    const source = new AudioSampleSource({
      codec: 'mp3',
      bitrate: 32_000,
      transform: { numberOfChannels: 1 },
    });
    output.addAudioTrack(source);
    try {
      await output.start();
      const channels = Array.from(
        { length: decoded.numberOfChannels },
        (_, index) => decoded.getChannelData(index),
      );
      const frames = Math.min(decoded.length, Math.round((end - start) * sampleRate));
      for (let first = 0; first < frames; first += blockFrames) {
        const size = Math.min(blockFrames, frames - first);
        const pcm = new Float32Array(size * channels.length);
        channels.forEach((channel, index) => {
          pcm.set(channel.subarray(first, first + size), size * index);
        });
        const sample = new AudioSample({
          data: pcm,
          format: 'f32-planar',
          numberOfChannels: channels.length,
          sampleRate,
          timestamp: first / sampleRate,
        });
        try {
          await source.add(sample);
        } finally {
          sample.close();
        }
      }
      source.close();
      await output.finalize();
    } catch (error) {
      await output.cancel();
      throw error;
    }
    return mp3.buffer;
  };
}
