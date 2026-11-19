# Anova pour Gladys Assistant

Affiche vos Anova Precision Cooker (cuiseurs sous vide) et Anova Precision Oven
dans Gladys par l'API officielle **Anova Developer** (un WebSocket du cloud
d'Anova), et permet à Gladys de les arrêter, et de démarrer une cuisson sous
vide si vous l'autorisez.

Jamais testé avec un vrai appareil : écrit d'après la documentation officielle
et la bibliothèque de l'intégration Anova de Home Assistant. Sans lien avec
Anova. Vos retours sont les bienvenus sur le forum Gladys.

## Ce qu'il faut

- Un compte Anova avec vos appareils appairés dans l'application Anova.
- Un **jeton d'accès personnel** : dans l'application **Anova Oven** (même pour
  un cuiseur sous vide : connectez-vous avec le même compte), allez dans
  **Plus → Développeur → Personal Access Tokens**, donnez-lui un nom et créez-le.
  Il commence par `anova-`. Un compte peut avoir jusqu'à 10 jetons.
- L'usage de l'API est soumis aux conditions d'utilisation de l'API Anova
  (<https://developer.anovaculinary.com/terms>) : usage personnel, non
  commercial.

## Configuration

1. Collez le jeton dans **Jeton d'accès personnel** et enregistrez. Le jeton est
   gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à Anova.
2. Le statut doit indiquer « Connecté à Anova : N appareils ».
3. Ouvrez l'onglet **Découverte** et ajoutez vos appareils.

## Fonctionnalités de chaque appareil

| Fonctionnalité     | Precision Cooker                                | Precision Oven                         |
| ------------------ | ----------------------------------------------- | -------------------------------------- |
| Température        | de l'eau (°C)                                   | du four, bulbe sec ou humide (°C)      |
| Température visée  | lecture seule (°C)                              | lecture seule, pendant la cuisson (°C) |
| Temps restant      | minutes (0 à l'arrêt)                           | minutes, quand la minuterie tourne     |
| Durée de cuisson   | minutes                                         | minutes, pendant la cuisson            |
| État               | à l'arrêt, préchauffage, cuisson, maintien…     | à l'arrêt ou cuisson                   |
| Alerte             | niveau d'eau bas ou critique, fuite, trop chaud | réservoir vide, porte ouverte          |
| Arrêter la cuisson | bouton                                          | bouton                                 |

Une valeur qu'Anova ne donne pas reste inconnue : elle n'est jamais affichée à 0. Anova envoie un état quand quelque chose change ; sans rien pendant 25 min,
l'intégration rouvre la connexion pour avoir des états frais (Anova ferme une
connexion inactive au bout de 30 min).

Les valeurs du four viennent de la description communautaire de ses messages
d'état : elles ne sont pas dans la documentation officielle. Les cuiseurs A3,
A4/A5 et A6/A7 envoient leur état sous des formes différentes, toutes lues ;
les autres types sont lus s'ils envoient l'une de ces formes.

## Arrêter

Le bouton **Arrêter la cuisson** de chaque appareil, et l'action de scène
**Anova : arrêter la cuisson**, ne demandent aucune option et ne sont jamais
refusés : ni par l'option de démarrage, ni par une pause demandée par Anova
(HTTP 429), ni par un jeton refusé (un essai par clic, et un pour un arrêt
gardé au redémarrage), ni par un `/data` lent ou illisible. Sans connexion,
une connexion est ouverte tout de suite ; si elle ne s'ouvre pas en 3,5 s,
l'arrêt est gardé (aussi dans `/data`, 10 min) et envoyé dès qu'une connexion
s'ouvre.

Un arrêt part avec un ping : sans la réponse, un message ou le pong sous 1,5 s,
la connexion est jugée morte (une box redémarrée, par exemple), coupée et
rouverte aussitôt, et l'arrêt part sur la nouvelle (3 connexions mortes au plus
par arrêt, puis le délai entre essais). Un tel envoi ne compte pas.

Il part 3 fois en tout au plus, de nouveau tant que l'appareil indique la même
cuisson 20 s après ; il n'est pas renvoyé si une autre cuisson apparaît (lancée
ensuite depuis l'application ou l'appareil). Un clic part toujours tout de
suite, quelle que soit la cuisson affichée, y compris sur la connexion qu'il a
ouverte lui-même dans ses 3,5 s. Seul un arrêt gardé (pas envoyé dans ces
3,5 s, ou relu de `/data` après un redémarrage) dont la cuisson est connue la
vérifie sur une nouvelle connexion, états reçus à l'ouverture compris (2 s au
plus) : à l'arrêt, c'est fini ; une autre cuisson, il ne part pas ; la même
cuisson, ou pas d'état, il part. Un arrêt déjà accepté par Anova est vérifié de
la même façon avant d'être renvoyé. L'identité de la cuisson est gardée dans
`/data`. Un arrêt annule aussi un démarrage pas encore envoyé.

Ce qu'un arrêt ne peut pas faire : joindre Anova sans jeton, ou avant que le
jeton soit lu depuis Gladys après un redémarrage (le jeton n'est jamais écrit
dans `/data`).

L'action de scène donne un résultat : `confirmed` (l'appareil indique l'arrêt),
`accepted` (Anova a répondu ok), `refused` (Anova a répondu une erreur : revérifié
et renvoyé), `sent` (envoyé, pas encore de réponse), `queued` (envoyé dès la
connexion) ou `skipped` (arrêt gardé non envoyé : une autre cuisson a été lancée).

## Démarrer une cuisson sous vide (désactivé par défaut)

Démarrer chauffe de l'eau : il faut l'option **Autoriser le démarrage d'une
cuisson**, désactivée par défaut. L'action de scène **Anova : démarrer une
cuisson sous vide** prend alors un Precision Cooker, une température (25 à
92 °C, arrondie à 0,1 °C) et une minuterie (minutes entières, 1 à 5999).
Vérifiez avant que le cuiseur est dans l'eau.

Le démarrage est refusé, et rien n'est envoyé, quand :

- l'option est désactivée (revérifiée juste avant l'envoi) ;
- l'appareil est un four (démarrer un four n'est pas pris en charge), ou n'est
  pas sur le compte Anova ;
- la température ou la minuterie est hors bornes ou n'est pas un nombre ;
- la connexion est fermée, ou il n'y a pas d'état du cuiseur sur la connexion
  en cours depuis moins de 30 minutes ;
- le cuiseur cuit déjà (ou son état est inconnu), ou signale un problème
  (niveau d'eau, fuite, trop chaud, panne) ;
- le cuiseur démarre ou se met à jour (état inconnu ou occupé) ;
- un autre démarrage du cuiseur est en cours, ou aucun état n'est arrivé depuis
  le dernier démarrage (un démarrage sans confirmation bloque le suivant jusqu'à
  un état reçu après lui) ;
- un arrêt du cuiseur est en cours, ou a été demandé entre-temps ;
- `/data` ne peut pas être écrit en 10 s (le démarrage y est noté avant de
  partir ; au-delà de 10 s, rien n'est envoyé : Gladys n'affiche jamais un
  échec pendant que l'eau chauffe).

Résultats : `started` (un état montre la cuisson), `accepted` (Anova a répondu
ok, pas encore d'état) ou `sent` (pas de réponse : sans confirmation). Un
démarrage refusé par Anova fait échouer l'action. Une cuisson en cours n'est
jamais modifiée : arrêtez-la, puis redémarrez. Changer la consigne pendant une
cuisson n'est pas dans cette version (les jetons d'accès personnels ne
permettent que démarrer, arrêter et l'unité de température).

## Arrêt à la fin de la minuterie (option, désactivée par défaut)

Comme dans l'application Anova, un Precision Cooker garde l'eau à température
quand sa minuterie se termine. Avec **Arrêter le cuiseur à la fin de sa
minuterie**, Gladys envoie un arrêt, une fois par cuisson, quand le cuiseur
indique sa minuterie finie.

## Connexion, limites et confidentialité

- Une connexion par intégration, adresse de la documentation ; le jeton va dans
  l'adresse comme la documentation l'exige : il n'est jamais journalisé, jamais
  affiché, jamais écrit dans `/data`. Le User-Agent indique `gladys-anova/<version>`.
- Anova coupe la connexion quand sa limite de débit est atteinte : l'intégration
  se reconnecte après 5 s, 15 s, 30 s, 1, 2, 5, 10 puis 30 min (de la moitié au
  tout de chaque palier), et repart de 5 s quand une connexion a tenu 3 min.
  Après un redémarrage, jamais plus vite (l'heure de la dernière tentative est
  dans `/data`).
- HTTP 429 : pause de la durée de son Retry-After (1 min à 6 h, 15 min sans),
  gardée dans `/data` au redémarrage. Un arrêt passe quand même.
- Jeton refusé : un HTTP 401, ou (ce que fait Anova d'un jeton invalide) une
  connexion fermée par Anova avec le code 1005 dans les 5 s après son
  ouverture, sans aucun message, deux fois de suite. Une coupure réseau ou un
  autre code (1006, 1012, 1013…) n'est jamais un refus. Rien n'est renvoyé tout seul : enregistrez un
  nouveau jeton, ou cliquez sur **Tester la connexion** (un nouvel essai). Seuls
  8 bits d'une empreinte du jeton refusé sont gardés dans `/data`. Un 403 ou un
  autre code n'est pas un refus : l'intégration espace ses essais.
- `/data` illisible : rien n'est envoyé tout seul (relu toutes les 10 s) ;
  **Tester la connexion** repart d'un état vide.
- Les messages de plus de 256 Ko sont coupés avant d'être lus.

## Tester la connexion

Se connecte tout de suite si besoin (au plus toutes les 30 s, pas pendant une
pause 429) et indique combien d'appareils Anova liste.
