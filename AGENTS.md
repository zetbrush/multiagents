# Règle de délégation du projet

## Répartition du travail

- Codex reste le coordinateur : il clarifie le besoin, choisit l'approche,
  définit les critères d'acceptation, tranche les vrais blocages et révise le résultat.
- Déléguer par défaut les missions de code substantielles à un seul exécutant
  Gemini Flash via l'orchestrateur MCP multiagents et Antigravity CLI (`agy`).
  Cela inclut les fonctionnalités, refactorisations et corrections qui demandent
  une exploration, plusieurs modifications liées ou plusieurs cycles de tests.
- Utiliser `execution_mode: "plan_execution"` et le modèle explicite
  `gemini-3.8-flash-high` et `reasoning_effort: "high"`. Garder l'optimisation activée pour que le lanceur
  transmette le modèle ; ne pas changer automatiquement de modèle.
- Déléguer également les petites modifications conformément à la préférence
  globale de l'utilisateur. Codex peut assurer directement les vérifications
  et réparations nécessaires au fonctionnement de l'outil de délégation.
- Cette règle porte sur des missions cohérentes, pas sur chaque écriture de fichier.
  Une consigne explicite de l'utilisateur pour la tâche en cours prévaut.

## Mission de l'exécutant

- Fournir un plan concis avec périmètre, contraintes, fichiers concernés,
  critères d'acceptation et commandes de vérification adaptées au projet.
  Utiliser Bun pour ce dépôt. Ne transmettre que le contexte utile.
- Laisser Gemini explorer, coder, tester et corriger de façon autonome dans ce
  périmètre. Ne pas demander une validation de Codex pour chaque commande ou fichier.
- Utiliser les étapes vérifiables du plan et les outils MCP de suivi. Remonter
  les changements significatifs, les blocages nécessitant une décision et le bilan
  final ; éviter les comptes rendus de chaque opération et les journaux volumineux.
- Respecter les pauses et limites de tentatives de `plan_execution`. En cas de
  blocage, préciser le problème, les essais effectués et la décision nécessaire.
- Ne pas lancer de sous-agents supplémentaires depuis l'exécutant par défaut.
  Cette règle vise un coordinateur Codex et un exécutant Gemini.

## Revue et limites

- Codex examine le diff, les critères qualitatifs et les résultats des contrôles
  avant d'approuver via `approve_execution`, puis libère l'exécutant. Un message
  de réussite de Gemini ne remplace pas cette revue.
- Demander les corrections dans la même session quand possible, via les outils
  de résolution/réouverture du plan. Éviter de refaire l'exploration de Gemini
  sans besoin identifié et de répéter les tests sans nouvelle raison.
- Si le CLI, l'authentification, le modèle ou l'orchestrateur est indisponible,
  expliquer le problème et tenter les réparations locales autorisées. Ne pas
  substituer silencieusement un autre modèle ou une équipe de sous-agents Codex.
  Continuer les travaux indépendants utiles ; signaler avant toute reprise
  substantielle de l'implémentation par Codex.
- Respecter les modifications existantes de l'utilisateur et les autorisations
  de la tâche. Cette règle ne donne pas d'autorisation supplémentaire de publier,
  déployer, supprimer des données ou envoyer des messages à des tiers.

Cette consigne précise pour ce dépôt la préférence globale enregistrée dans
`~/.codex/AGENTS.md`, applicable aux sessions Codex qui la chargent.
