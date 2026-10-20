# Cloud computers

Every task runs on its own cloud computer. tavya can run it on its own accounts (charged to your plan's compute), or on yours: connect an account under **Settings → Computers**, and your tasks use it at the provider's price, with nothing added.

| | Disk | Paused | Good for |
|---|---|---|---|
| E2B | up to ~29 GB | memory kept, resumes in a second | the fastest start; a desktop or an outbound allowlist |
| Daytona | up to 10 GB | resumes in seconds | the same, smaller disks |
| Fly.io | up to 500 GB | disk kept, wakes in ~5 s | large disks |
| Hetzner | up to 10 TB | disk kept, wakes in ~30–60 s | the lowest price (EU) |
| AWS | up to 16 TB | disk kept, wakes in ~20–40 s | your own AWS account, any region |
| Google Cloud | up to 64 TB | disk kept, wakes in ~20–40 s | your own Google Cloud project; machines of exactly the size you choose |

On Fly.io, Hetzner, AWS and Google Cloud a computer's disk keeps everything, including files Git ignores, and grows while the task runs. They have no desktop and no outbound allowlist.

## AWS

tavya makes each computer in the region's default VPC: an instance with a public address (only SSH on port 2222 is open), and a gp3 volume for its files. A paused computer is a stopped instance, so you pay only for its disks.

1. In the IAM console, create a user (no console access), for example `tavya`.
2. Give it this inline policy. It may create only what it tags, and change only what tavya tagged:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Read", "Effect": "Allow", "Action": ["ec2:Describe*", "pricing:GetProducts"], "Resource": "*" },
    { "Sid": "LaunchTagged", "Effect": "Allow", "Action": ["ec2:RunInstances", "ec2:CreateVolume"],
      "Resource": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"],
      "Condition": { "Null": { "aws:RequestTag/karmaxHome": "false" } } },
    { "Sid": "LaunchFrom", "Effect": "Allow", "Action": "ec2:RunInstances",
      "Resource": ["arn:aws:ec2:*::image/*", "arn:aws:ec2:*::snapshot/*", "arn:aws:ec2:*:*:subnet/*",
        "arn:aws:ec2:*:*:network-interface/*", "arn:aws:ec2:*:*:security-group/*"] },
    { "Sid": "TagWhileCreating", "Effect": "Allow", "Action": "ec2:CreateTags", "Resource": "*",
      "Condition": { "StringEquals": { "ec2:CreateAction": ["RunInstances", "CreateVolume", "CreateSecurityGroup", "CreateImage"] } } },
    { "Sid": "ManageTagged", "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute",
        "ec2:AttachVolume", "ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:CreateTags"],
      "Resource": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"],
      "Condition": { "Null": { "aws:ResourceTag/karmaxHome": "false" } } },
    { "Sid": "SecurityGroup", "Effect": "Allow", "Action": "ec2:CreateSecurityGroup",
      "Resource": ["arn:aws:ec2:*:*:vpc/*", "arn:aws:ec2:*:*:security-group/*"] },
    { "Sid": "OpenSsh", "Effect": "Allow", "Action": "ec2:AuthorizeSecurityGroupIngress", "Resource": "arn:aws:ec2:*:*:security-group/*",
      "Condition": { "Null": { "aws:ResourceTag/karmaxSecurityGroup": "false" } } },
    { "Sid": "BuildImage", "Effect": "Allow", "Action": "ec2:CreateImage",
      "Resource": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*::image/*", "arn:aws:ec2:*::snapshot/*"] },
    { "Sid": "RemoveOldImages", "Effect": "Allow", "Action": ["ec2:DeregisterImage", "ec2:DeleteSnapshot"],
      "Resource": ["arn:aws:ec2:*::image/*", "arn:aws:ec2:*::snapshot/*"],
      "Condition": { "Null": { "aws:ResourceTag/karmaxImage": "false" } } }
  ]
}
```

3. Under the user's **Security credentials**, create an access key ("Application running outside AWS").
4. In tavya, **Settings → Computers → AWS → Connect**: paste the access key ID and the secret access key. Under **Advanced**, choose the region (default `eu-central-1`).

The first computer in a region builds tavya's machine image there (about 10 minutes, once); until then computers set themselves up from Debian, which takes a few minutes more. A new AWS account may run only a few CPUs at once: ask for more under **Service Quotas → Amazon EC2 → Running On-Demand Standard instances**. A region without a default VPC needs one (**VPC → Your VPCs → Actions → Create default VPC**).

## Google Cloud

tavya makes each computer in the project's `default` network: an E2 machine of exactly the size you choose, with a public address (only SSH on port 2222 is open), and a balanced persistent disk for its files. Machines get no service account, so nothing on them can act on your project.

1. Create a project for tavya (or use one), with billing on, and enable the **Compute Engine API**. Enabling the **Cloud Billing API** too lets tavya show your region's prices.
2. **IAM & Admin → Service accounts → Create service account**, for example `tavya`, with the role **Compute Admin**.
3. On the service account, **Keys → Add key → Create new key → JSON**.
4. In tavya, **Settings → Computers → Google Cloud → Connect**: paste the key file, or drop it on the field. Under **Advanced**, choose the zone (default `europe-west3-a`).

A new project may run only a few CPUs at once: ask for more under **IAM & Admin → Quotas** (`CPUs` in your region).
