# Slite to Outline migration tool
This is a tool to import data backed up or exported from Slite into Outline.

This tool migrates documents exported from Slite into Outline, retaining all linked images and linked documents.

### Prepare your data
When you download a backup or export from Slite, your data will be sent to you via a download link sent to your email. 

Once downloaded, extract the contents and open the backup folder.

Move all the contents of the backup folder into the following folder which is in the root of this project:
```bash
./slite-backup
```

Ensure that the `channels` folder from your export is located directly inside the `/slite-backup` folder.

The tool will look for your export content inside this folder structure from the root directory of this project:
```bash
./slite-backup/channels/
```

> [!NOTE]
> The organization.json file and the /users folder which are included in your Slite backup folder will be ignored by this tool.


### Obtain your Outline API key
Follow the instructions below to obtain your Outline API key:
1. Access your Outline instance
2. Access settings by click on your workspace name, then settings
3. Click on API from the left menu, under the Account section
4. Click on '+ New API key...'
5. Give your new API key a name, and specify an expiration period
6. Copy your Outline API key

> [!NOTE]
> If the sole purpose of the API key is for this migration, the default 7 day expiration period will suffice.

### Create your .env file
Ensure to create a .env file in the root of your project.

Add your Outline URL and paste in your Outline API key to the .env file.

Here is an example of what your .env file should look like:
```bash
OUTLINE_API_KEY=ol_api_123456789abcdefghijklmnopqrstuvxyz0etc
OUTLINE_DOMAIN=https://docs.myoutlinedomain.com 
```

### Run the tool
To run, execute the below from terminal.

First, ensure that you have installed all packages required:
```bash
bun install
```

Next, run the tool:
```bash
bun run start
```
