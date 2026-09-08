# État des lieux - Projet OptIA / Multiagents

## Références et Environnement
- **Dépôt GitHub** : `aristidew1/multiagents` (nommé également `OptIA`).
- **Dossier principal** : `/home/giovanni/Documents/multiagent` (laissé sur la branche `main`).
- **Worktree** : `/home/giovanni/Documents/optia-optimization` sur la branche `codex/optia-economy`, basé sur le commit `5b05ed6` (update 48) de la branche `feat/autonomous-plan`.

## Acquis
- Mode `plan_execution` implémenté dans le commit `5b05ed6`.
- CLI `agy` 1.1.27 installé.
- Authentification Google et réponse réelle validées précédemment avec Flash Medium.
- Orchestrateur Codex configuré.

## Configuration et Préférences Actuelles
- **Flash** : modèle `gemini-3.8-flash-high`, effort `high`.
- **Codex** : coordinateur / reviewer frugal.

## Baseline du Worktree (au 7 septembre)
- 203 tests passants, 0 échec.
- `bun install --frozen-lockfile` échoue (lockfile à examiner).
- Dépendances de test réutilisées via un symlink local `node_modules` (ne pas commiter ce lien).
- *Note : aucun test récent ni aucune optimisation n'ont été effectués.*

## Historique de Session
- Première session d'optimisation arrêtée après un changement volontaire de branche par l'utilisateur.
- Aucune optimisation de cette passe n'a été livrée ni validée.

## Reste à Faire
- Relancer Flash dans le worktree.
- Réduire les consignes MCP répétées et le doublon peer tout en préservant les configurations étrangères.
- Garantir un modèle et un effort explicites même lorsque `optimization.enabled=false`.
- Produire des comptes rendus brefs.
- Réaliser les tests de régression et une mission réelle de bout en bout.
- Mesurer les caractères de contexte et l'usage réellement disponible (sans promettre de pourcentage d'économie).
- Conversation Gemini persistante : envisageable uniquement lors d'une seconde passe si justifiée.

## Vigilance Outillage MCP
- Dans les outils MCP actuellement chargés, seul `create_team` n'expose pas `plan_execution`.
- `get_team_status` expose bien `wait_seconds` dans le schéma chargé actuellement (attente serveur disponible).
- Recharger depuis la bonne version avant reprise.
