"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MFA_REQUIRED_ROLES = exports.SituationStatus = exports.PollingUnitStatus = exports.PollingUnitStrength = exports.FieldReportType = exports.VerificationStatus = exports.SupportGroupCategory = exports.ScopeType = exports.CampaignRole = void 0;
var CampaignRole;
(function (CampaignRole) {
    CampaignRole["CANDIDATE"] = "CANDIDATE";
    CampaignRole["CAMPAIGN_DIRECTOR"] = "CAMPAIGN_DIRECTOR";
    CampaignRole["STATE_COORDINATOR"] = "STATE_COORDINATOR";
    CampaignRole["LGA_COORDINATOR"] = "LGA_COORDINATOR";
    CampaignRole["WARD_COORDINATOR"] = "WARD_COORDINATOR";
    CampaignRole["SUPPORT_GROUP_LEADER"] = "SUPPORT_GROUP_LEADER";
    CampaignRole["VOLUNTEER_COORDINATOR"] = "VOLUNTEER_COORDINATOR";
    CampaignRole["POLLING_AGENT_COORDINATOR"] = "POLLING_AGENT_COORDINATOR";
    CampaignRole["DATA_ANALYST"] = "DATA_ANALYST";
    CampaignRole["MEDIA_TEAM"] = "MEDIA_TEAM";
    CampaignRole["POLLING_AGENT"] = "POLLING_AGENT";
    CampaignRole["VOLUNTEER"] = "VOLUNTEER";
})(CampaignRole || (exports.CampaignRole = CampaignRole = {}));
var ScopeType;
(function (ScopeType) {
    ScopeType["STATE"] = "STATE";
    ScopeType["SENATORIAL_DISTRICT"] = "SENATORIAL_DISTRICT";
    ScopeType["LGA"] = "LGA";
    ScopeType["WARD"] = "WARD";
    ScopeType["POLLING_UNIT"] = "POLLING_UNIT";
    ScopeType["CAMPAIGN"] = "CAMPAIGN";
})(ScopeType || (exports.ScopeType = ScopeType = {}));
var SupportGroupCategory;
(function (SupportGroupCategory) {
    SupportGroupCategory["YOUTH"] = "YOUTH";
    SupportGroupCategory["WOMEN"] = "WOMEN";
    SupportGroupCategory["FARMERS"] = "FARMERS";
    SupportGroupCategory["PROFESSIONALS"] = "PROFESSIONALS";
    SupportGroupCategory["STUDENTS"] = "STUDENTS";
    SupportGroupCategory["RELIGIOUS"] = "RELIGIOUS";
    SupportGroupCategory["COMMUNITY"] = "COMMUNITY";
})(SupportGroupCategory || (exports.SupportGroupCategory = SupportGroupCategory = {}));
var VerificationStatus;
(function (VerificationStatus) {
    VerificationStatus["PENDING"] = "PENDING";
    VerificationStatus["VERIFIED"] = "VERIFIED";
    VerificationStatus["ACTIVE"] = "ACTIVE";
    VerificationStatus["REJECTED"] = "REJECTED";
})(VerificationStatus || (exports.VerificationStatus = VerificationStatus = {}));
var FieldReportType;
(function (FieldReportType) {
    FieldReportType["SECURITY_CONCERN"] = "SECURITY_CONCERN";
    FieldReportType["COMMUNITY_REQUEST"] = "COMMUNITY_REQUEST";
    FieldReportType["OPPOSITION_ACTIVITY"] = "OPPOSITION_ACTIVITY";
    FieldReportType["CAMPAIGN_PROGRESS"] = "CAMPAIGN_PROGRESS";
    FieldReportType["DAILY_SITREP"] = "DAILY_SITREP";
})(FieldReportType || (exports.FieldReportType = FieldReportType = {}));
var PollingUnitStrength;
(function (PollingUnitStrength) {
    PollingUnitStrength["STRONG"] = "STRONG";
    PollingUnitStrength["SWING"] = "SWING";
    PollingUnitStrength["WEAK"] = "WEAK";
})(PollingUnitStrength || (exports.PollingUnitStrength = PollingUnitStrength = {}));
var PollingUnitStatus;
(function (PollingUnitStatus) {
    PollingUnitStatus["ACTIVE"] = "ACTIVE";
    PollingUnitStatus["INACTIVE"] = "INACTIVE";
    PollingUnitStatus["NEEDS_ATTENTION"] = "NEEDS_ATTENTION";
})(PollingUnitStatus || (exports.PollingUnitStatus = PollingUnitStatus = {}));
var SituationStatus;
(function (SituationStatus) {
    SituationStatus["OPEN"] = "OPEN";
    SituationStatus["REPORTING"] = "REPORTING";
    SituationStatus["CLOSED"] = "CLOSED";
    SituationStatus["INCIDENT"] = "INCIDENT";
})(SituationStatus || (exports.SituationStatus = SituationStatus = {}));
exports.MFA_REQUIRED_ROLES = [
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COORDINATOR,
];
//# sourceMappingURL=enums.js.map