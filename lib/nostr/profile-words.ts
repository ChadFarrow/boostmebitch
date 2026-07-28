// Word lists for the generated display names on Google-onboarded accounts
// (see generated-profile.ts). 128 x 128 = 16,384 pairs.
//
// The name carries no discriminator suffix, so collisions are visible when two
// users land on the same pair. 128-entry lists are the mitigation: 64 x 64
// would collide roughly 16x more often for the same cosmetic benefit.
//
// Screen additions for how they read NEXT TO an arbitrary noun, not just on
// their own — the pairing is uncontrolled.

export const ADJECTIVES: readonly string[] = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'breezy', 'calm', 'candid',
  'cheerful', 'clever', 'coral', 'cosmic', 'cozy', 'crimson', 'crystal', 'curious',
  'daring', 'dapper', 'dawn', 'deep', 'dusky', 'eager', 'early', 'electric',
  'emerald', 'ember', 'fabled', 'fair', 'fearless', 'fleet', 'floating', 'frosty',
  'genial', 'gentle', 'gilded', 'glad', 'gleaming', 'golden', 'grand', 'happy',
  'hidden', 'honest', 'humble', 'ivory', 'jade', 'jolly', 'keen', 'kind',
  'lively', 'lucid', 'lunar', 'marble', 'mellow', 'merry', 'midnight', 'mighty',
  'misty', 'modest', 'noble', 'northern', 'olive', 'opal', 'patient', 'pearl',
  'plucky', 'polar', 'proud', 'purple', 'quick', 'quiet', 'radiant', 'rapid',
  'ready', 'restless', 'rising', 'roaming', 'rosy', 'royal', 'ruby', 'rustic',
  'sage', 'sapphire', 'scarlet', 'serene', 'sharp', 'shining', 'silent', 'silver',
  'simple', 'sleepy', 'smooth', 'snowy', 'solar', 'southern', 'sparkling', 'spirited',
  'spry', 'steady', 'stellar', 'stormy', 'sturdy', 'sunny', 'sunlit', 'swift',
  'tawny', 'tender', 'thoughtful', 'tidal', 'tiny', 'tranquil', 'true', 'twilight',
  'valiant', 'velvet', 'verdant', 'vivid', 'wandering', 'warm', 'watchful', 'wild',
  'willing', 'windy', 'winter', 'wise', 'witty', 'woven', 'zealous', 'zesty',
];

export const NOUNS: readonly string[] = [
  'otter', 'falcon', 'heron', 'badger', 'marten', 'lynx', 'ibex', 'osprey',
  'raven', 'wren', 'finch', 'sparrow', 'kestrel', 'harrier', 'curlew', 'plover',
  'puffin', 'gannet', 'tern', 'egret', 'bittern', 'crane', 'stork', 'ibis',
  'teal', 'pintail', 'eider', 'merlin', 'goshawk', 'buzzard', 'kite', 'owl',
  'robin', 'thrush', 'dipper', 'warbler', 'pipit', 'lark', 'martin', 'swallow',
  'starling', 'jackdaw', 'rook', 'chough', 'magpie', 'jay', 'nutcracker', 'crossbill',
  'siskin', 'redpoll', 'linnet', 'bunting', 'hare', 'stoat', 'weasel', 'polecat',
  'fox', 'deer', 'elk', 'bison', 'tapir', 'okapi', 'gazelle', 'oryx',
  'kudu', 'eland', 'addax', 'saiga', 'markhor', 'tahr', 'chamois', 'vicuna',
  'guanaco', 'llama', 'alpaca', 'seal', 'walrus', 'narwhal', 'beluga', 'orca',
  'dolphin', 'porpoise', 'manatee', 'dugong', 'turtle', 'terrapin', 'gecko', 'skink',
  'iguana', 'chameleon', 'salamander', 'newt', 'axolotl', 'frog', 'perch', 'tench',
  'rudd', 'chub', 'dace', 'barbel', 'gudgeon', 'loach', 'minnow', 'salmon',
  'trout', 'char', 'grayling', 'pike', 'bream', 'carp', 'ray', 'comet',
  'nebula', 'quasar', 'meteor', 'aurora', 'zephyr', 'monsoon', 'cyclone', 'current',
  'harbor', 'lantern', 'beacon', 'compass', 'anchor', 'summit', 'canyon', 'meadow',
];
