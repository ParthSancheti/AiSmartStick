/**
 * AI Smart Stick — Cloud Functions (region asia-south1).
 *  Callables (Auth + App Check enforced): assistantTurn, assistantVision, mapsSearch, mapsPlace,
 *  mapsRoute, mapsReverse, createPairingCode, claimPairingCode, revokeRelationship, updateRelationship.
 *  Triggers: SOS push, SOS resolved, device disconnect / critical battery, geofence, stale location
 *  sweep, camera request wake-up.
 */
export { assistantTurn, assistantVision } from './assistant';
export { mapsSearch, mapsPlace, mapsRoute, mapsReverse, mapsAutocomplete } from './maps';
export { createPairingCode, claimPairingCode, revokeRelationship, updateRelationship } from './pairing';
export { deleteAccount } from './account';
export { sendRemoteCommand } from './commands';
export { onSosCreated, onSosUpdated, onLiveDevice, onLiveLocation, staleLocationSweep, onCameraSessionCreated } from './notify';
export { getLatestFirmwareRelease } from './ota';
