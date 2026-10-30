---
title: Metadata, permissions and packaging
summary: SFDX project layout, object/field metadata, permission sets, package.xml rules.
---
# Metadata, permissions and packaging

## SFDX layout

```
force-app/main/default/
  classes/  triggers/  lwc/  flows/  objects/{Object}/fields/{Field}.field-meta.xml
  permissionsets/  layouts/  flexipages/  customMetadata/  labels/  staticresources/
manifest/package.xml
```

## Field metadata example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Escalation_Level__c</fullName>
    <label>Escalation Level</label>
    <type>Picklist</type>
    <required>false</required>
    <description>Current escalation tier of the case.</description>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <value><fullName>Tier_1</fullName><default>false</default><label>Tier 1</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

## Permission sets

- One permission set per capability (`{Capability}_Access`). Grant object CRUD, FLS, Apex class access, tab visibility.
- **Never put required fields in a permission set** (deployment fails).
- Story-scoped permission set (`{CODE}_Permissions`) for safe testing in shared sandboxes + the canonical permission set update for the merge.

## package.xml rules

- Every new component is added to the main `manifest/package.xml` (source of truth) and to the story manifest.
- Group members by `<types><name>` (ApexClass, ApexTrigger, CustomField as `Object.Field__c`, CustomObject, Flow, LightningComponentBundle, PermissionSet, Layout, FlexiPage…), sorted alphabetically, `<version>62.0</version>`.
- Validate: `sf project deploy validate -x manifest/package.xml -l RunLocalTests -o {alias}`.
