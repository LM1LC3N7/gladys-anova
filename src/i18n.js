// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, feature names, states, alerts,
// command results), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  APC: {
    temperature: both('Water temperature', "Température de l'eau"),
    'target-temperature': both('Target temperature', 'Température visée'),
    'timer-remaining': both('Time remaining', 'Temps restant'),
    'timer-total': both('Cook time', 'Durée de cuisson'),
    state: both('State', 'État'),
    alert: both('Alert', 'Alerte'),
    stop: both('Stop cooking', 'Arrêter la cuisson'),
  },
  APO: {
    temperature: both('Oven temperature', 'Température du four'),
    'target-temperature': both('Target temperature', 'Température visée'),
    'timer-remaining': both('Time remaining', 'Temps restant'),
    'timer-total': both('Cook time', 'Durée de cuisson'),
    state: both('State', 'État'),
    alert: both('Alert', 'Alerte'),
    stop: both('Stop cooking', 'Arrêter la cuisson'),
  },
};

export const DEFAULT_NAMES = {
  APC: both('Anova Precision Cooker', 'Anova Precision Cooker'),
  APO: both('Anova Precision Oven', 'Anova Precision Oven'),
};

export const STATE_NAMES = {
  idle: both('Idle', 'À l’arrêt'),
  preheating: both('Preheating', 'Préchauffage'),
  cooking: both('Cooking', 'Cuisson'),
  maintaining: both('Timer done, keeping the temperature', 'Minuterie finie, maintien au chaud'),
  low_water: both('Water level too low', 'Niveau d’eau trop bas'),
  high_temperature: both('Temperature too high', 'Température trop haute'),
  failure: both('Device failure', 'Panne de l’appareil'),
  busy: both('Starting or updating', 'Démarrage ou mise à jour'),
  unknown: both('Unknown', 'Inconnu'),
};

export const ALERT_NAMES = {
  none: both('None', 'Aucune'),
  water_leak: both('Water leak', 'Fuite d’eau'),
  water_critical: both('Water level critical', 'Niveau d’eau critique'),
  water_temperature_high: both('Water too hot', 'Eau trop chaude'),
  water_low: both('Water level low', 'Niveau d’eau bas'),
  water_tank_empty: both('Water tank empty', 'Réservoir d’eau vide'),
  door_open: both('Door open', 'Porte ouverte'),
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const plural = (n, en, fr) =>
  both(`${n} ${en}${n > 1 ? 's' : ''}`, `${n} ${fr}${n > 1 ? 's' : ''}`);

export const T = {
  noToken: both(
    'Enter a personal access token of your Anova account (Anova Oven app, More, Developer, Personal Access Tokens).',
    "Saisissez un jeton d'accès personnel de votre compte Anova (application Anova Oven, Plus, Développeur, Personal Access Tokens).",
  ),
  tokenInvalid: both(
    'This is not a personal access token: it starts with "anova-". Nothing is sent.',
    "Ce n'est pas un jeton d'accès personnel : il commence par « anova- ». Rien n'est envoyé.",
  ),
  connecting: both('Connecting to Anova…', 'Connexion à Anova…'),
  connected: (count) => {
    const devices = plural(count, 'device', 'appareil');
    return both(
      `Connected to Anova: ${devices.en}. Open Discovery to add them.`,
      `Connecté à Anova : ${devices.fr}. Ouvrez Découverte pour les ajouter.`,
    );
  },
  noDevice: both(
    'Connected to Anova, but the account lists no device.',
    'Connecté à Anova, mais le compte ne liste aucun appareil.',
  ),
  refused: both(
    'Anova refused the personal access token (HTTP 401): create a new one in the app and save it, or click "Test the connection". No new try by itself.',
    "Anova a refusé le jeton d'accès personnel (HTTP 401) : créez-en un nouveau dans l'application et enregistrez-le, ou cliquez sur « Tester la connexion ». Aucun nouvel essai tout seul.",
  ),
  refusedClosed: both(
    'Anova closed the connection twice right after opening it, without any message: the personal access token is probably refused. Create a new one and save it, or click "Test the connection". No new try by itself.',
    "Anova a fermé la connexion deux fois juste après l'avoir ouverte, sans aucun message : le jeton d'accès personnel est sans doute refusé. Créez-en un nouveau et enregistrez-le, ou cliquez sur « Tester la connexion ». Aucun nouvel essai tout seul.",
  ),
  tooMany: (wait) =>
    both(
      `Anova asks to slow down (HTTP 429). Connecting again in ${wait.en}.`,
      `Anova demande de ralentir (HTTP 429). Nouvelle connexion dans ${wait.fr}.`,
    ),
  unreachable: (wait) =>
    both(
      `Anova cannot be reached. New try in ${wait.en}.`,
      `Anova est injoignable. Nouvel essai dans ${wait.fr}.`,
    ),
  httpError: (status, wait) =>
    both(
      `Anova refused the connection (HTTP ${status}). New try in ${wait.en}.`,
      `Anova a refusé la connexion (HTTP ${status}). Nouvel essai dans ${wait.fr}.`,
    ),
  lost: (wait) =>
    both(
      `The connection to Anova was closed (Anova closes it when its rate limit is reached). Connecting again in ${wait.en}.`,
      `La connexion à Anova a été fermée (Anova la ferme quand sa limite de débit est atteinte). Nouvelle connexion dans ${wait.fr}.`,
    ),
  dataUnreadable: both(
    'The state file in /data cannot be read: nothing is sent until it can (read again every 10 s). "Test the connection" starts again from an empty state.',
    "Le fichier d'état de /data est illisible : rien n'est envoyé tant qu'il ne l'est pas (relu toutes les 10 s). « Tester la connexion » repart d'un état vide.",
  ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: trying again.',
    "La configuration n'a pas pu être lue depuis Gladys : nouvel essai.",
  ),
  test: {
    cooldown: both('Tested less than 30 s ago.', 'Testé il y a moins de 30 s.'),
    waiting: both(
      'Still connecting to Anova: look at the status in a minute.',
      'Connexion à Anova en cours : regardez le statut dans une minute.',
    ),
  },
};

/** Results of the commands (scene action outputs, logs) and their refusals. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  startDisabled: both(
    'Starting a cook is not allowed: turn on "Allow starting a cook" in the configuration. Nothing was sent.',
    "Démarrer une cuisson n'est pas autorisé : activez « Autoriser le démarrage d'une cuisson » dans la configuration. Rien n'a été envoyé.",
  ),
  notCooker: both(
    'Choose an Anova Precision Cooker of this integration: nothing was sent.',
    "Choisissez un Anova Precision Cooker de cette intégration : rien n'a été envoyé.",
  ),
  ovenStart: both(
    'Starting an oven is not supported: nothing was sent.',
    "Démarrer un four n'est pas pris en charge : rien n'a été envoyé.",
  ),
  temperature: (min, max) =>
    both(
      `The temperature must be between ${min} and ${max} °C: nothing was sent.`,
      `La température doit être comprise entre ${min} et ${max} °C : rien n'a été envoyé.`,
    ),
  minutes: (min, max) =>
    both(
      `The cook time must be a whole number of minutes between ${min} and ${max}: nothing was sent.`,
      `La durée doit être un nombre entier de minutes entre ${min} et ${max} : rien n'a été envoyé.`,
    ),
  notConnected: both(
    'Not connected to Anova: nothing was sent.',
    "Non connecté à Anova : rien n'a été envoyé.",
  ),
  unknownDevice: both(
    'This device is not on the Anova account (yet): nothing was sent.',
    "Cet appareil n'est pas (encore) sur le compte Anova : rien n'a été envoyé.",
  ),
  noFreshState: both(
    'No recent state of the cooker on this connection: nothing was sent. Try again in a minute.',
    "Aucun état récent du cuiseur sur cette connexion : rien n'a été envoyé. Réessayez dans une minute.",
  ),
  alreadyCooking: both(
    'The cooker is already cooking (or its state is unknown): stop it first. Nothing was sent.',
    "Le cuiseur cuit déjà (ou son état est inconnu) : arrêtez-le d'abord. Rien n'a été envoyé.",
  ),
  deviceAlert: both(
    'The cooker reports a problem (water level, failure): nothing was sent.',
    "Le cuiseur signale un problème (niveau d'eau, panne) : rien n'a été envoyé.",
  ),
  stopping: both(
    'A stop of this device is in progress: nothing was sent.',
    "Un arrêt de cet appareil est en cours : rien n'a été envoyé.",
  ),
  busy: both(
    'Another start of this cooker is in progress: nothing was sent.',
    "Un autre démarrage de ce cuiseur est en cours : rien n'a été envoyé.",
  ),
  cancelledByStop: both(
    'Cancelled: a stop was requested meanwhile, nothing was sent.',
    "Annulé : un arrêt a été demandé entre-temps, rien n'a été envoyé.",
  ),
  dataNotSaved: both(
    'The state could not be written to /data: nothing was sent.',
    "L'état n'a pas pu être écrit dans /data : rien n'a été envoyé.",
  ),
  refusedByAnova: both(
    'Anova refused the command: nothing was started.',
    "Anova a refusé la commande : aucune cuisson n'a démarré.",
  ),
};
