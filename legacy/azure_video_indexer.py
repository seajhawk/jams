from requests import get, post

location = "eastus"
accountId = "3788c0b8-64d6-49b5-8c7e-218901146d90" # from https://www.videoindexer.ai/account/3788c0b8-64d6-49b5-8c7e-218901146d90/settings
name = "SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.mp4"

headers = {
    'Ocp-Apim-Subscription-Key': 'YOUR_SUBSCRIPTION_KEY'
}

subscriptionId = "a0bb6d67-bbb2-4cf3-be46-717ea8141752" # Microsoft Azure Sponsorship


# Get ARM account access token
# Portal: https://portal.azure.com/#@chrisharriskids.onmicrosoft.com/resource/subscriptions/a0bb6d67-bbb2-4cf3-be46-717ea8141752/resourcegroups/JAMS/providers/Microsoft.VideoIndexer/accounts/jams-vi/management_api_item
# or REST: https://learn.microsoft.com/en-us/rest/api/videoindexer/preview/generate/access-token?tabs=HTTP

armAccessTokenUri = "https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.VideoIndexer/accounts/{accountName}/generateAccessToken?api-version=2022-07-20-preview"
body = {
    "permissionType": "Contributor",
    "scope": "Account"
}

# Get account access token
accessTokenUri = f"https://api.videoindexer.ai/auth/{location}/Accounts/{accountId}/AccessToken?allowEdit=true&allowUpload=true&accessToken"

accessToken = get(accessTokenUri).json()


# Upload a video
uploadUri = f"https://api.videoindexer.ai/{location}/Accounts/{accountId}/Videos?name={name}[&privacy][&priority][&description][&partition][&externalId][&externalUrl][&callbackUrl][&metadata][&language][&videoUrl][&fileName][&excludedAI][&indexingPreset][&streamingPreset][&linguisticModelId][&personModelId][&sendSuccessEmail][&assetId][&brandsCategories][&customLanguages][&logoGroupId][&useManagedIdentityToDownloadVideo][&accessToken]"

videoId = ""

# Get video index
getUri = f"https://api.videoindexer.ai/{location}/Accounts/{accountId}/Videos/{videoId}/Index[?language][&reTranslate][&includeStreamingUrls][&includedInsights][&excludedInsights][&includeSummarizedInsights][&accessToken]"