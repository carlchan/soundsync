import debug from 'debug';
import uuidv4 from 'uuid/v4';

import { PassThrough } from 'stream';
import eos from 'end-of-stream';
import {
  SourceDescriptor, SourceType, BaseSourceDescriptor,
} from './source_type';
import { AudioSourcesSinksManager } from '../audio_sources_sinks_manager';
import { getPeersManager } from '../../communication/peers_manager';
import { AudioInstance, MaybeAudioInstance } from '../utils';
import { now } from '../../utils/time';

// This is an abstract class that shouldn't be used directly but implemented by real audio sources
export abstract class AudioSource {
  name: string;
  type: SourceType;
  rate = 0;
  channels: number;
  log: debug.Debugger;
  local: boolean;
  uuid: string;
  peerUuid: string;
  manager: AudioSourcesSinksManager;
  instanceUuid; // this is an id only for this specific instance, not saved between restart it is used to prevent a sink or source info being overwritten by a previous instance of the same sink/source
  // we separate the two streams so that we can synchronously create the encodedAudioStream which will be empty while the
  // real source initialize, this simplify the code needed to handle the source being started twice at the same time
  encodedAudioStream: PassThrough; // stream used to redistribute the audio chunks to every sink
  protected directSourceStream: NodeJS.ReadableStream; // internal stream from the source
  startedAt: number;
  private consumersStreams: PassThrough[] = [];
  latency = 2000;

  protected abstract _getAudioEncodedStream(): Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;

  constructor(descriptor: MaybeAudioInstance<SourceDescriptor>, manager: AudioSourcesSinksManager) {
    this.manager = manager;
    this.type = descriptor.type;
    this.uuid = descriptor.uuid || uuidv4();
    this.peerUuid = descriptor.peerUuid;
    this.name = descriptor.name;
    this.startedAt = descriptor.startedAt;
    this.latency = descriptor.latency || 500;
    this.channels = descriptor.channels || 2;
    this.instanceUuid = descriptor.instanceUuid || uuidv4();
    this.log = debug(`soundsync:audioSource:${this.uuid}`);
    this.log(`Created new audio source`);
  }

  get peer() {
    return getPeersManager().peers[this.peerUuid];
  }

  // Change info about a source in response to a user event
  patch(descriptor: Partial<SourceDescriptor>) {
    return this.updateInfo(descriptor);
  }

  // Update source info in response to a controllerMessage
  updateInfo(descriptor: Partial<AudioInstance<SourceDescriptor>>) {
    if (this.local && descriptor.instanceUuid && descriptor.instanceUuid !== this.instanceUuid) {
      this.log('Received update for a different instance of the source, ignoring (can be because of a restart of the client or a duplicated config on two clients)');
      return;
    }
    let hasChanged = false;
    Object.keys(descriptor).forEach((prop) => {
      if (descriptor[prop] !== undefined && this[prop] !== descriptor[prop]) {
        hasChanged = true;
        this[prop] = descriptor[prop];
      }
    });
    if (hasChanged) {
      this.manager.emit('sourceUpdate', this);
      this.manager.emit('soundstateUpdated');
    }
  }

  async start(): Promise<PassThrough> {
    if (!this.encodedAudioStream) {
      this.log(`Starting audio source`);
      this.encodedAudioStream = new PassThrough();
      this.encodedAudioStream.on('data', (d) => {
        this.consumersStreams.forEach((s) => s.write(d));
      });
      if (this.local) {
        this.updateInfo({ startedAt: now() });
      }
      this.directSourceStream = await this._getAudioEncodedStream();
      this.directSourceStream.on('finish', () => {
        this.log('Source stream finished, cleaning source');
        // when the readable stream finishes => when the source program exit / source file finishes
        if (this.encodedAudioStream) {
          this.encodedAudioStream.destroy();
        }
        delete this.encodedAudioStream;
        delete this.directSourceStream;
      });
      this.directSourceStream.pipe(this.encodedAudioStream);
    }

    const instanceStream = new PassThrough();
    this.consumersStreams.push(instanceStream);
    eos(instanceStream, () => {
      this.consumersStreams = this.consumersStreams.filter((s) => s !== instanceStream);
      if (this.consumersStreams.length === 0) {
        this.handleNoMoreReadingSink();
      }
    });
    return instanceStream;
  }

  protected handleNoMoreReadingSink() {
    // by default do nothing
    // this keeps process like librespot running in the background
    // but can be changed by other sources like remote_source to stop receiving data
  }

  toObject = () => ({
    name: this.name,
    uuid: this.uuid,
    type: this.type,
    channels: this.channels,
    rate: this.rate,
    peerUuid: this.peerUuid,
    latency: this.latency,
  })

  toDescriptor = (): AudioInstance<BaseSourceDescriptor> => ({
    name: this.name,
    uuid: this.uuid,
    type: this.type,
    latency: this.latency,
    startedAt: this.startedAt,
    peerUuid: this.peerUuid,
    instanceUuid: this.instanceUuid,
    channels: this.channels,
  })
}
