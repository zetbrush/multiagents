# Exécution autonome d’un plan avec Gemini

Statut : validé par l’utilisateur ; implémentation réalisée et vérifiée localement.

## Objectif

L’utilisateur discute avec Codex et valide un plan. Un seul exécutant Gemini
réalise les étapes, vérifie ses changements et poursuit sans revue intermédiaire
systématique. Codex intervient pour une décision nécessaire, un blocage persistant
ou la revue finale. Réutiliser le broker, les sessions et les outils MCP existants.

## Choix proposé

Ajouter un mode explicite `plan_execution`, compatible avec le mode équipe actuel.
Un script appelant simplement Antigravity serait plus petit mais perdrait la
reprise, le suivi et les messages déjà disponibles. Réécrire l’orchestrateur
ajouterait du travail sans bénéfice démontré pour ce besoin.

## Contrat du plan

Chaque étape possède un identifiant stable, un objectif, ses dépendances,
le périmètre des fichiers, des critères de réussite et les vérifications attendues.
Les commandes de vérification et leur répertoire font partie du plan approuvé.
Valider les références, cycles et champs requis avant de lancer l’exécutant.
Les étapes sont exécutées séquentiellement pour cette première version.

Une étape passe de pending à in_progress puis completed ou blocked. completed
signifie que les critères et vérifications de l’étape sont satisfaits ; cela ne
constitue pas une approbation finale de la session. Les vérifications impossibles
sont rapportées explicitement et ne sont jamais considérées comme réussies.

## Autonomie et remontée des problèmes

Gemini choisit les détails d’implémentation dans le périmètre autorisé. Les étapes
sensibles peuvent porter un point de décision explicite avant leur exécution.
Il remonte les ambiguïtés qui changent le périmètre ou le comportement attendu.
Après deux tentatives infructueuses de correction d’un même blocage, il suspend
l’étape et transmet le problème, les essais, les preuves et la décision attendue.
Une réponse résout le point de décision et autorise la reprise depuis ce point.

Le modèle est fixé explicitement au démarrage et conservé à la reprise. Dans ce
mode, aucun changement automatique de modèle. Les erreurs de connexion, quotas
et processus sont distinguées des difficultés de réalisation ; elles ne prouvent
pas une incapacité du modèle. Les nouvelles tentatives techniques sont bornées.

## Fin de travail et supervision

Un silence déclenche un diagnostic d’activité, jamais une déclaration de réussite.
L’absence de relecteur laisse la session en attente de revue. Codex reçoit à la
fin un résumé des étapes, les fichiers modifiés, les résultats des vérifications
et les questions restantes. Seule une approbation explicite clôt la revue.

Les contrôles exécutables sont lancés et leur code de sortie conservé par le
programme ; les critères qualitatifs restent soumis à la revue. Aucun succès
n’est déduit du seul texte produit par l’exécutant.

## Persistance et consommation

Persister le plan, son avancement, la tâche initiale, le modèle choisi et les
blocages. À la reprise, reconstruire le contexte depuis ces données et l’état des
fichiers, sans rejouer les étapes déjà terminées ni écraser les changements.
Un contrôle interrompu est à relancer avant de déclarer l’étape terminée.

Limiter les messages à la fin d’une étape, aux blocages et au résultat final.
Conserver les logs détaillés localement avec une référence dans les résumés.
Afficher une consommation inconnue comme inconnue, jamais comme zéro ; distinguer
les tokens mesurés des quotas de l’abonnement Google.

## Périmètre de réalisation et validation

Étendre les types et la persistance du broker, les outils de plan de l’adaptateur,
le lancement, la reprise et les transitions du superviseur. Isoler les règles
du nouveau mode dans un module dédié plutôt que grossir le serveur principal.
Documenter un exemple Codex coordinateur avec un seul exécutant Antigravity.

Tester les transitions, dépendances, blocages, modèle conservé à la reprise,
échecs de vérification, redémarrages et absence d’approbation automatique.
Tester une exécution complète avec un faux processus pour les cas déterministes.
Enfin réaliser une petite tâche réelle avec le compte Google connecté, sous
réserve de disponibilité d’Antigravity et du modèle dans ce compte. Ce dernier
essai est indispensable pour revendiquer la compatibilité de bout en bout.

Pas de nouveau tableau de bord, de parallélisme supplémentaire ni de réécriture
générale dans cette première version.
