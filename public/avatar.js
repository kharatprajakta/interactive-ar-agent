// Animated Kenney "Mini Characters" (CC0, https://kenney.nl/assets/mini-characters).
// Each KittenTTS voice gets its own character. The avatar plays the model's
// idle/emote animations and layers procedural head motion on top: looking at
// the viewer, tilting while listening or thinking, and bobbing to the speech.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const MODEL_DIR = 'models/kenney/';
const TARGET_HEIGHT = 0.8; // metres, before any AR scaling
const FADE = 0.25;

/** Which character each KittenTTS voice uses. */
export const VOICE_CHARACTERS = {
  Bella: 'character-female-e',
  Luna: 'character-female-b',
  Rosie: 'character-female-c',
  Kiki: 'character-female-d',
  Jasper: 'character-male-a',
  Bruno: 'character-male-b',
  Hugo: 'character-male-c',
  Leo: 'character-male-d',
};
export const DEFAULT_CHARACTER = VOICE_CHARACTERS.Kiki;

const loader = new GLTFLoader();
const cache = new Map(); // character name -> Promise<gltf>

const _pos = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

function lerpAngle(a, b, k) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
}

export class Avatar {
  constructor() {
    this.group = new THREE.Group();
    this.state = 'idle';
    this.speaking = false;
    this.getLevel = null; // optional () => audio RMS level, or null
    this.talk = 0;
    this.pulse = 0;
    this.headPitch = 0;
    this.headRoll = 0;
    this.character = null;
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.current = null;
    this.loadToken = 0;

    // Soft contact shadow so the character looks grounded in AR.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.group.add(shadow);
  }

  /** Swap to another character (e.g. 'character-male-b'). Resolves once it's visible. */
  async setCharacter(name) {
    if (name === this.character) return;
    this.character = name;
    const token = ++this.loadToken;

    if (!cache.has(name)) cache.set(name, loader.loadAsync(`${MODEL_DIR}${name}.glb`));
    let gltf;
    try {
      gltf = await cache.get(name);
    } catch (err) {
      cache.delete(name);
      throw err;
    }
    if (token !== this.loadToken) return; // a newer request won

    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((o) => {
      if (o.isMesh) o.frustumCulled = false; // skinned bounds are unreliable
    });

    // Normalise size so every character stands TARGET_HEIGHT tall on y = 0.
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y || 1;
    model.scale.setScalar(TARGET_HEIGHT / height);
    model.position.y = -box.min.y * model.scale.y;

    if (this.model) {
      this.mixer.stopAllAction();
      this.group.remove(this.model);
    }
    this.model = model;
    this.group.add(model);

    this.head = model.getObjectByName('head');
    this.headRest = this.head?.quaternion.clone();
    this.headScale = this.head?.scale.clone();

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, this.mixer.clipAction(clip)]));
    this.mixer.addEventListener('finished', () => this._play('idle'));
    this.current = null;
    this._play('idle');
    this.wave();
  }

  _play(name, { once = false } = {}) {
    const next = this.actions[name];
    if (!next || next === this.current) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.play();
    if (this.current) next.crossFadeFrom(this.current, FADE, false);
    this.current = next;
  }

  setState(state) {
    this.state = state;
  }

  /** Nudge the head on a spoken word boundary (browser TTS). */
  syllable() {
    this.pulse = 0.6;
  }

  /** A friendly gesture, e.g. after being placed or switching voice. */
  wave() {
    this._play('emote-yes', { once: true });
  }

  update(dt, t, viewerPosition) {
    if (!this.model) return;

    // Turn toward the viewer (yaw only).
    this.group.getWorldPosition(_pos);
    const dx = viewerPosition.x - _pos.x;
    const dz = viewerPosition.z - _pos.z;
    const k = 1 - Math.exp(-dt * 4);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dx, dz), k);

    // Reset the head before the mixer runs, so our offsets never accumulate
    // on frames where the current clip doesn't animate the head.
    if (this.head) {
      this.head.quaternion.copy(this.headRest);
      this.head.scale.copy(this.headScale);
    }
    this.mixer.update(dt);
    if (!this.head) return;

    // Talking: follow the real audio level (KittenTTS), or fake a rhythm (browser TTS).
    let talkTarget = 0;
    if (this.speaking) {
      const level = this.getLevel?.();
      talkTarget =
        level != null
          ? Math.min(1, level * 7)
          : 0.3 + 0.7 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 4.3)) + this.pulse;
    }
    this.pulse = Math.max(0, this.pulse - dt * 4);
    this.talk += (talkTarget - this.talk) * (1 - Math.exp(-dt * 18));

    // Look at the viewer, plus state-specific poses.
    const headY = _pos.y + TARGET_HEIGHT * 0.8 * this.group.scale.y;
    let pitch = -Math.atan2(viewerPosition.y - headY, Math.hypot(dx, dz)) * 0.5;
    let roll = Math.sin(t * 0.9) * 0.03;
    if (this.state === 'thinking') {
      roll += 0.2;
      pitch -= 0.15;
    } else if (this.state === 'listening') {
      roll -= 0.12;
      pitch += 0.08;
    }
    this.headPitch += (THREE.MathUtils.clamp(pitch, -0.4, 0.4) - this.headPitch) * k;
    this.headRoll += (roll - this.headRoll) * k;

    _euler.set(this.headPitch - this.talk * 0.12, 0, this.headRoll);
    this.head.quaternion.multiply(_quat.setFromEuler(_euler));
    // A small squash-and-stretch reads as "talking" on these mouthless faces.
    this.head.scale.y *= 1 + this.talk * 0.06;
    this.head.scale.x *= 1 - this.talk * 0.02;
  }
}
