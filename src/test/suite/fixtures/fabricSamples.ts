/**
 * Real Fabric exports, used as test fixtures. Shared by test files; not a test file itself.
 */

/**
 * A Python (not PySpark) notebook named "Scratch2", downloaded from Fabric as .ipynb
 * (2026-11). It has a Built-in resource (helper.py) in Fabric, which the .ipynb doesn't include.
 */
export const SCRATCH2_IPYNB = `{"cells":[{"cell_type":"markdown","source":["# Scratch2"],"metadata":{},"id":"c0000001"},{"cell_type":"code","source":["print(\\"Hi!\\")"],"outputs":[{"output_type":"display_data","data":{"application/vnd.jupyter.statement-meta+json":{"session_id":"00000000-0000-0000-0000-000000000002","normalized_state":"finished","queued_time":"2026-11-04T11:53:49.692764Z","session_start_time":"2026-11-04T11:53:49.6935861Z","execution_start_time":"2026-11-04T11:53:52.9963266Z","execution_finish_time":"2026-11-04T11:53:55.814515Z","parent_msg_id":"00000000-0000-0000-0000-000000000003"}},"metadata":{}},{"output_type":"stream","name":"stdout","text":["Hi!\\n"]}],"execution_count":1,"metadata":{"microsoft":{"language":"python","language_group":"jupyter_python"}},"id":"c0000002"}],"metadata":{"kernel_info":{"name":"jupyter","jupyter_kernel_name":"python3.12"},"kernelspec":{"name":"jupyter","display_name":"Jupyter"},"language_info":{"name":"python"},"microsoft":{"language":"python","language_group":"jupyter_python","ms_spell_check":{"ms_spell_check_language":"en"}},"nteract":{"version":"nteract-front-end@1.0.0"},"spark_compute":{"compute_id":"/trident/default","session_options":{"conf":{"spark.synapse.nbs.session.timeout":"1200000"}}}},"nbformat":4,"nbformat_minor":5}`;

/**
 * A new PySpark notebook named "Scratch3", downloaded from the Fabric UI as .ipynb (2026-11).
 * Notable: cell IDs are UUIDs, the markdown cell has `microsoft` and `nteract` metadata, the
 * code cell's last line ends in "\n", and `dependencies` is present but empty.
 */
export const SCRATCH3_IPYNB = `{"cells":[{"cell_type":"markdown","source":["# Scratch3"],"metadata":{"nteract":{"transient":{"deleting":false}},"microsoft":{"language":"python","language_group":"synapse_pyspark"}},"id":"00000000-0000-0000-0000-000000000004"},{"cell_type":"code","source":["# Welcome to your new notebook\\n","# Type here in the cell editor to add code!\\n"],"outputs":[],"execution_count":null,"metadata":{"microsoft":{"language":"python","language_group":"synapse_pyspark"}},"id":"00000000-0000-0000-0000-000000000005"}],"metadata":{"kernel_info":{"name":"synapse_pyspark"},"kernelspec":{"name":"synapse_pyspark","display_name":"synapse_pyspark"},"language_info":{"name":"python"},"microsoft":{"language":"python","language_group":"synapse_pyspark","ms_spell_check":{"ms_spell_check_language":"en"}},"nteract":{"version":"nteract-front-end@1.0.0"},"spark_compute":{"compute_id":"/trident/default","session_options":{"conf":{"spark.synapse.nbs.session.timeout":"1200000"}}},"dependencies":{}},"nbformat":4,"nbformat_minor":5}`;

/**
 * "Scratch2" again (Python notebook, 2026-11), now with a T-SQL cell (`%%tsql`, language
 * `sql`) and an attached lakehouse in `dependencies`.
 */
export const SCRATCH2_TSQL_LAKEHOUSE_IPYNB = `{"cells":[{"cell_type":"markdown","source":["# Scratch2"],"metadata":{},"id":"c0000001"},{"cell_type":"code","source":["print(\\"Hi!\\")"],"outputs":[{"output_type":"display_data","data":{"application/vnd.jupyter.statement-meta+json":{"session_id":"00000000-0000-0000-0000-000000000002","normalized_state":"finished","queued_time":"2026-11-04T11:53:49.692764Z","session_start_time":"2026-11-04T11:53:49.6935861Z","execution_start_time":"2026-11-04T11:53:52.9963266Z","execution_finish_time":"2026-11-04T11:53:55.814515Z","parent_msg_id":"00000000-0000-0000-0000-000000000003"}},"metadata":{}},{"output_type":"stream","name":"stdout","text":["Hi!\\n"]}],"execution_count":1,"metadata":{"microsoft":{"language":"python","language_group":"jupyter_python"}},"id":"c0000002"},{"cell_type":"code","source":["%%tsql\\n","SELECT * FROM table"],"outputs":[],"execution_count":null,"metadata":{"microsoft":{"language":"sql","language_group":"jupyter_python"}},"id":"00000000-0000-0000-0000-000000000006"}],"metadata":{"kernel_info":{"name":"jupyter","jupyter_kernel_name":"python3.12"},"kernelspec":{"name":"jupyter","display_name":"Jupyter"},"language_info":{"name":"python"},"microsoft":{"language":"python","language_group":"jupyter_python","ms_spell_check":{"ms_spell_check_language":"en"}},"nteract":{"version":"nteract-front-end@1.0.0"},"spark_compute":{"compute_id":"/trident/default","session_options":{"conf":{"spark.synapse.nbs.session.timeout":"1200000"}}},"dependencies":{"lakehouse":{"known_lakehouses":[{"id":"00000000-0000-0000-0000-000000000007"}],"default_lakehouse":"00000000-0000-0000-0000-000000000007","default_lakehouse_name":"mylakehouse","default_lakehouse_workspace_id":"00000000-0000-0000-0000-000000000008"}}},"nbformat":4,"nbformat_minor":5}`;

/**
 * Fabric Git-format notebooks committed by Fabric, from Microsoft's fabric-cicd repository
 * (MIT licence, Copyright (c) Microsoft Corporation):
 * https://github.com/microsoft/fabric-cicd/tree/main/sample/workspace
 * "Example Notebook" has an attached lakehouse; "Hello World" an attached environment.
 */
export const FABRIC_CICD_EXAMPLE_PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "00000000-0000-0000-0000-000000000009",
# META       "default_lakehouse_name": "WithoutSchema",
# META       "default_lakehouse_workspace_id": "00000000-0000-0000-0000-000000000010",
# META       "known_lakehouses": [
# META         {
# META           "id": "00000000-0000-0000-0000-000000000009"
# META         }
# META       ]
# META     }
# META   }
# META }

# CELL ********************

# Welcome to your new notebook
# Type here in the cell editor to add code!
print("This notebook is attached to the 'WithoutSchema' lakehouse.")
print("This its SQL analytics endpoint: sqlserverconnectionstringinoriginlakehouse.com")
print("This workspace includes 'SampleEventhouse' eventhouse.")
print("This its eventhouse query URI: https://trd-origineventhouse.z4.kusto.fabric.microsoft.com")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

export const FABRIC_CICD_HELLO_WORLD_PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "environment": {
# META       "environmentId": "00000000-0000-0000-0000-000000000011",
# META       "workspaceId": "00000000-0000-0000-0000-000000000000"
# META     }
# META   }
# META }

# CELL ********************

print("Hello World")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

/**
 * The same "Scratch2" notebook as SCRATCH2_TSQL_LAKEHOUSE_IPYNB, downloaded in Fabric's Git
 * format (2026-11). Confirms: `# MARKDOWN` cells have no metadata block, a T-SQL cell is
 * written as `# MAGIC` lines, and a Python notebook's header has the `jupyter` kernel.
 */
export const SCRATCH2_TSQL_LAKEHOUSE_PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "jupyter",
# META     "jupyter_kernel_name": "python3.12"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "00000000-0000-0000-0000-000000000007",
# META       "default_lakehouse_name": "mylakehouse",
# META       "default_lakehouse_workspace_id": "00000000-0000-0000-0000-000000000008",
# META       "known_lakehouses": [
# META         {
# META           "id": "00000000-0000-0000-0000-000000000007"
# META         }
# META       ]
# META     }
# META   }
# META }

# MARKDOWN ********************

# # Scratch2

# CELL ********************

print("Hi!")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "jupyter_python"
# META }

# CELL ********************

# MAGIC %%tsql
# MAGIC SELECT * FROM table

# METADATA ********************

# META {
# META   "language": "sql",
# META   "language_group": "jupyter_python"
# META }
`;

/**
 * The same "Scratch3" notebook as SCRATCH3_IPYNB, downloaded in Fabric's Git format (2026-11).
 * Shows how Fabric writes a cell whose source ends in "\n": the newline stays in the body,
 * so the cell is followed by two blank lines instead of one.
 */
export const SCRATCH3_PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# # Scratch3

# CELL ********************

# Welcome to your new notebook
# Type here in the cell editor to add code!


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;
