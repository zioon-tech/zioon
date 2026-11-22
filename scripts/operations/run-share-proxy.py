"""Run the bounded proxy transaction using the existing production OIDC role."""
import base64
import json
import os
import pathlib
import sys
import time

root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / ".release-tools" / "scripts"))
from cloud import request, rpc, python_command

repository = os.environ["GITHUB_REPOSITORY"]
run_id = os.environ["CI_RUN"]
if repository != "zioon-tech/zioon" or os.environ["GITHUB_REF"] != "refs/heads/main" or not run_id.isdecimal():
    raise RuntimeError("Proxy maintenance requires a numeric main-branch CI run")
headers = {"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"}
run = json.loads(request("https://api.github.com/repos/" + repository + "/actions/runs/" + run_id, headers=headers))
if (run["status"] != "completed" or run["conclusion"] != "success"
        or run["head_branch"] != "main" or run["event"] != "push"
        or run["head_sha"] != os.environ["GITHUB_SHA"]
        or run["path"] != ".github/workflows/ci.yml"):
    raise RuntimeError("Selected CI must verify this exact main commit")
oidc = json.loads(request(os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=sts.aliyuncs.com", headers={
    "Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
}))["value"]
credentials = rpc("sts.cn-shanghai.aliyuncs.com", "2015-04-01", "AssumeRoleWithOIDC", {
    "RoleArn": os.environ["DEPLOY_ROLE_ARN"],
    "OIDCProviderArn": os.environ["DEPLOY_OIDC_PROVIDER_ARN"],
    "OIDCToken": oidc, "RoleSessionName": "share-proxy-" + os.environ["GITHUB_RUN_ID"],
    "DurationSeconds": 3600,
})["Credentials"]
remote = (root / "scripts" / "operations" / "share-proxy.py").read_text()
remote += "\nrun(check_only=" + repr(os.environ["CHECK_ONLY"] == "true") + ")\n"
command = python_command(remote)
response = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "RunCommand", {
    "RegionId": "cn-shanghai", "InstanceId.1": os.environ["DEPLOY_INSTANCE_ID"],
    "CommandContent": base64.b64encode(command.encode()).decode(), "ContentEncoding": "Base64",
    "Type": "RunShellScript", "Name": "zioon-share-proxy-" + run_id,
    "Timeout": 300, "KeepCommand": "false",
}, credentials)
invocation = response["InvokeId"]
print(json.dumps({"status": "proxy_command_started", "invocationId": invocation,
                  "commit": run["head_sha"], "ciRun": run_id}), flush=True)
# Never submit another command after an invocation ID has been returned.
for attempt in range(100):
    result = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "DescribeInvocationResults", {
        "RegionId": "cn-shanghai", "InvokeId": invocation,
        "InstanceId": os.environ["DEPLOY_INSTANCE_ID"], "ContentEncoding": "PlainText",
    }, credentials)
    outcomes = result.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
    if outcomes and outcomes[0]["InvocationStatus"] in ("Success", "Failed", "Stopped", "PartialFailed", "Finished"):
        outcome = outcomes[0]
        print(outcome.get("Output", ""), flush=True)
        if outcome["InvocationStatus"] != "Success" or int(outcome["ExitCode"]) != 0:
            raise RuntimeError("Proxy transaction failed; reconcile invocation " + invocation)
        break
    time.sleep(3)
else:
    raise RuntimeError("Proxy outcome unknown; reconcile invocation " + invocation)
