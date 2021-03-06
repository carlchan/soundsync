import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { assert } from '../../utils/assert';
import { getLocalPeer } from '../local_peer';
import { SOUNDSYNC_VERSION } from '../../utils/constants';
import { getPeersManager } from '../get_peers_manager';
import { WebrtcPeer } from '../wrtc_peer';
import { WebrtcInitiator, InitiatorMessage, InitiatorMessageContent } from './initiator';
import { PeerConnectionInfoMessage } from '../messages';

const log = debug('soundsync:peerRelayInitiator');

const initiatorsListener: {[initiatorUuid: string]: (message: PeerConnectionInfoMessage) => unknown} = {};

export class PeerRelayInitiator extends WebrtcInitiator {
  type = 'peer relay';
  private receivedMessagesUuid: string[] = [];

  constructor(
    uuid: string,
    public handleReceiveMessage: (message: InitiatorMessage) => Promise<void>,
    public targetUuid: string,
  ) {
    super(uuid, handleReceiveMessage);
    initiatorsListener[this.uuid] = (message: PeerConnectionInfoMessage) => {
      if (this.receivedMessagesUuid.includes(message.messageUuid)) {
        return;
      }
      this.receivedMessagesUuid.push(message.messageUuid);
      this.handleReceiveMessage(message);
    };
  }

  destroy = () => {
    this.stopPolling();
    delete initiatorsListener[this.uuid];
  }

  sendMessage = async (message: InitiatorMessageContent) => {
    getPeersManager().broadcast({
      type: 'peerConnectionInfo',
      messageUuid: uuidv4(),
      targetUuid: this.targetUuid,
      senderVersion: SOUNDSYNC_VERSION,
      senderUuid: getLocalPeer().uuid,
      senderInstanceUuid: getLocalPeer().instanceUuid,
      initiatorUuid: this.uuid,
      ...message,
    }, [getLocalPeer().uuid]);
  }
}

export const createPeerRelayServiceInitiator = (targetUuid: string, uuid?: string) => (
  (handleReceiveMessage: (message: InitiatorMessage) => Promise<void>) => (
    new PeerRelayInitiator(uuid, handleReceiveMessage, targetUuid)
  ));

export const handlePeerRelayInitiatorMessage = async (message: PeerConnectionInfoMessage) => {
  try {
    const { initiatorUuid } = message;
    const {
      senderUuid, senderInstanceUuid, senderVersion,
    } = message;

    assert(senderUuid !== getLocalPeer().uuid, 'Connecting to own peer');

    if (!initiatorsListener[initiatorUuid]) {
      assert(senderVersion === SOUNDSYNC_VERSION, `Different version of Soundsync, please check each client is on the same version.\nOwn version: ${SOUNDSYNC_VERSION}\nOther peer version: ${senderVersion}`);

      const peer = new WebrtcPeer({
        uuid: `placeholderForPeerRelayInitiatorRequest_${initiatorUuid}`,
        name: `placeholderForPeerRelayInitiatorRequest_${senderUuid}`,
        instanceUuid: senderInstanceUuid,
        initiatorConstructor: createPeerRelayServiceInitiator(senderUuid, initiatorUuid),
      });
      getPeersManager().registerPeer(peer);
    }
    await initiatorsListener[initiatorUuid](message);
  } catch (e) {
    log('Error while treating message', e);
  }
};
