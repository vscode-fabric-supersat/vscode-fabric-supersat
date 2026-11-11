# Changelog

## [Unreleased]

- Feature: **Initial base extension** for VS Code desktop and web.
- Feature: **Select Workspace** current workspce, command, and status bar item.
- Feature: **Notebooks as files**. Download a notebook to `src/Notebooks/<Name>/<Name>.py` (Fabric Git format, for source control) and `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb` (local, with outputs). Either opens in the notebook editor, saving one updates the other, and **Save and Upload Notebook** uploads by name, overwriting or creating the notebook. Files are recognised by path and content (`# Fabric notebook source`). **Create New Fabric Notebook** starts a new PySpark or Python notebook locally.
