# Changelog

## [Unreleased]

- Feature: **Initial base extension** for VS Code desktop and web.
- Feature: **Select Workspace** set workspace, command, and status bar item.
- Feature: **Notebooks as files**. Download a notebook to `src/Notebooks/<Name>/<Name>.py` (Fabric Git format, for source control) and `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb` (local, with outputs). Either opens in the notebook editor, saving one updates the other, and **Save and Upload Notebook** uploads by name, overwriting or creating the notebook. Files are recognised by path and content (`# Fabric notebook source`). **Create New Fabric Notebook** starts a new PySpark or Python notebook locally. Plus an extensive range of notebook handling.
- Experimental: **Use Fabric Data Engineering** (desktop only) copies the project's notebooks into `.fabric-supersat/fabric-de/` in Microsoft Fabric Data Engineering's work folder layout and points its `synapse.localWorkFolderPath` setting there, so its Fabric kernel can run them; **Stop Using Fabric Data Engineering** restores the previous setting.
